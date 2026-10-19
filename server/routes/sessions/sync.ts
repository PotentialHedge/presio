// Sharing a deck: from the presenter's browser (POST /api/sessions), from a
// staged handoff (claim), or from an external URL; and the signed-in
// account's live synced decks (GET /api/sessions/mine).

import type express from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { nanoid } from "nanoid";
import { isValidHttpsUrl, isValidTotalSlides } from "../../validation.js";
import { getBearerToken, requireUser, resolveOptionalUserId } from "../../auth.js";
import { isLocalMode } from "../../local/mode.js";
import { countDeckPages } from "../../lib/pdfDoc.js";
import { loadControlledSession } from "../../lib/sessionAccess.js";
import { generatePassphrase, insertSession, ownedExpiry } from "../../lib/sessionRows.js";
import { deckTitle, isPdfUpload, singleField, uploadField } from "../../lib/upload.js";
import type { RouteDeps } from "./index.js";

// How many synced presentations a single user may have live at once. Sessions
// expire (and are marked 'expired' on end), so this caps concurrent —
// not lifetime — presentations.
export const MAX_CONCURRENT_PRESENTATIONS = 3;

const CAP_REACHED = `You can have at most ${MAX_CONCURRENT_PRESENTATIONS} synced presentations at once. End one before syncing another.`;

/**
 * How many synced presentations this user has live right now. `exceptId`
 * leaves one row out, so a re-claim of the same code doesn't count itself.
 * Null means the count failed and the caller must not assume there's room.
 */
async function liveSyncedCount(supabase: SupabaseClient, userId: string, exceptId?: string): Promise<number | null> {
  const base = supabase
    .from("sessions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("local", false);
  const scoped = exceptId ? base.neq("id", exceptId) : base;
  const { count, error } = await scoped.neq("status", "expired").gt("expires_at", new Date().toISOString());
  return error ? null : (count ?? 0);
}

/**
 * Before a share: whether the user has room for one more synced deck. Answers
 * and returns false when not.
 */
async function hasRoom(supabase: SupabaseClient, res: express.Response, userId: string, exceptId?: string): Promise<boolean> {
  const live = await liveSyncedCount(supabase, userId, exceptId);
  if (live === null) {
    res.status(500).json({ error: "Failed to check presentation limit" });
    return false;
  }
  if (live >= MAX_CONCURRENT_PRESENTATIONS) {
    res.status(403).json({ error: CAP_REACHED });
    return false;
  }
  return true;
}

/**
 * After a share: the pre-check races with concurrent shares (check-then-act
 * isn't atomic), so re-count now that this one is visible. True when parallel
 * requests overshot and the caller must roll back. Fail-closed: in the rare
 * tie both revert and the user simply retries one.
 */
async function overshot(supabase: SupabaseClient, userId: string): Promise<boolean> {
  const after = await liveSyncedCount(supabase, userId);
  return after !== null && after > MAX_CONCURRENT_PRESENTATIONS;
}

/** The presenter's slide from a share's form, when it sent a usable one. */
function currentSlideField(value: unknown, totalSlides: number): number | null {
  const slide = parseInt(String(value), 10);
  return Number.isFinite(slide) && slide >= 1 ? Math.min(slide, totalSlides) : null;
}

export function registerSyncRoutes(app: express.Express, { supabase }: RouteDeps) {
  /**
   * GET /api/sessions/mine — the signed-in account's live synced presentations,
   * newest first. The home screen asks this on any device the user signs in on:
   * local decks are device-bound IndexedDB, but synced ones belong to the
   * account, so a new device needs this list (plus each deck's controller
   * token — the owner is entitled to it, and without it the device could never
   * open the controller). Local handoff rows are excluded: their PDF only ever
   * belongs in the creating browser.
   */
  if (!isLocalMode) {
    app.get("/api/sessions/mine", async (req, res) => {
      const user = await requireUser(supabase, req);
      if (!user) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      // The filter comes from the verified token only — a client-supplied id
      // is never trusted, so no account can see another's rows.
      const { data, error } = await supabase
        .from("sessions")
        .select("id, filename, total_slides, created_at, expires_at, controller_token")
        .eq("user_id", user.id)
        .eq("local", false)
        .neq("status", "expired")
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false });
      if (error) {
        res.status(500).json({ error: "Failed to list presentations" });
        return;
      }
      // Whitelist the response fields; only controller_token is renamed.
      res.json(
        (data ?? []).map((row) => ({
          id: row.id,
          filename: row.filename,
          total_slides: row.total_slides,
          created_at: row.created_at,
          expires_at: row.expires_at,
          controllerToken: row.controller_token,
        }))
      );
    });
  }

  // Share a presentation that until now existed only in the presenter's
  // browser: the PDF is uploaded and its session row is created here — which is
  // where the join code is minted, by insertSession's collision-retrying insert.
  // The client proposes no id and no code.
  //
  // This is the create-with-PDF counterpart of POST /api/sessions/:id/claim.
  // A deck imported in the browser has no row to claim (that's what lets the
  // import work with no connection at all); a deck staged by POST /api/present
  // does, keeps its code, and still goes through claim.
  app.post("/api/sessions", uploadField("pdf"), async (req, res) => {
    // Hosted mode ties a synced presentation to the logged-in owner and caps
    // how many they may have live. Local/offline mode has no accounts: the
    // controller token handed back below is the only credential there is.
    let userId: string | null = null;
    if (!isLocalMode) {
      const user = await requireUser(supabase, req);
      if (!user) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      userId = user.id;
      if (!(await hasRoom(supabase, res, userId))) return;
    }

    const file = req.file;
    if (!isPdfUpload(file)) {
      res.status(400).json({ error: "A PDF file is required" });
      return;
    }

    const rawName = singleField(req.body.filename);
    if (rawName === null) {
      res.status(400).json({ error: "filename was sent more than once" });
      return;
    }
    const filename = deckTitle(rawName) || "Presentation";

    const pages = await countDeckPages(file.buffer);
    if (!pages.ok) {
      res.status(pages.status).json({ error: pages.error });
      return;
    }
    const { totalSlides } = pages;

    // The row is inserted before the upload because the code it reserves is
    // also the object path. It starts as a local placeholder, so a failed
    // upload can never leave a synced row pointing at a PDF that isn't there.
    const controllerToken = nanoid(24);
    const id = await insertSession(supabase, {
      pdf_path: "",
      filename,
      total_slides: totalSlides,
      controller_token: controllerToken,
      // Minted on first need instead (POST /api/sessions/:id/passphrase):
      // most decks are never co-presented.
      passphrase: "",
      local: true,
      user_id: userId,
      // A shared deck should outlive the default 24h anonymous expiry so it
      // doesn't vanish mid-session — same TTL a claim grants.
      expires_at: ownedExpiry(),
    });
    if (!id) {
      res.status(500).json({ error: "Failed to create session" });
      return;
    }

    const pdfPath = `${id}.pdf`;
    const discard = async () => {
      await supabase.storage.from("presentations").remove([pdfPath]);
      await supabase.from("sessions").update({ status: "expired" }).eq("id", id);
    };
    const { error: uploadError } = await supabase.storage
      .from("presentations")
      .upload(pdfPath, file.buffer, { contentType: "application/pdf", upsert: true });
    if (uploadError) {
      await supabase.from("sessions").update({ status: "expired" }).eq("id", id);
      res.status(500).json({ error: "Failed to upload PDF" });
      return;
    }

    // Preserve the presenter's position: a local deck's slide changes were
    // never persisted server-side, so this is the first the row hears of it.
    const currentSlide = currentSlideField(req.body.current_slide, totalSlides);
    const { error: updateError } = await supabase
      .from("sessions")
      .update({ local: false, pdf_path: pdfPath, ...(currentSlide ? { current_slide: currentSlide } : {}) })
      .eq("id", id);
    if (updateError) {
      await discard();
      res.status(500).json({ error: "Failed to update session" });
      return;
    }

    if (userId && (await overshot(supabase, userId))) {
      await discard();
      res.status(403).json({ error: CAP_REACHED });
      return;
    }

    res.json({ id, totalSlides, controllerToken });
  });

  // Reserve a session whose PDF is hosted externally ("bring your own storage").
  // The client has already loaded the PDF from `url` to derive total_slides, so we
  // store only the URL — no bytes are uploaded and there is no storage cost, which
  // is why this needs neither login nor the synced-presentation cap. Viewers fetch
  // the PDF directly from the URL, so it must be a public, CORS-friendly host.
  app.post("/api/sessions/external", async (req, res) => {
    const url = req.body.url;
    const filename = typeof req.body.filename === "string" ? req.body.filename : "";
    const totalSlides = parseInt(req.body.total_slides, 10);
    if (!isValidHttpsUrl(url)) {
      res.status(400).json({ error: "A valid https PDF URL is required" });
      return;
    }
    if (!filename || !isValidTotalSlides(totalSlides)) {
      res.status(400).json({ error: "filename and total_slides are required" });
      return;
    }

    const userId = await resolveOptionalUserId(supabase, req);

    const controllerToken = nanoid(24);
    const passphrase = generatePassphrase();
    const id = await insertSession(supabase, {
      pdf_path: "",
      pdf_url: url,
      filename,
      total_slides: totalSlides,
      controller_token: controllerToken,
      passphrase,
      local: false,
      user_id: userId,
      ...(userId ? { expires_at: ownedExpiry() } : {}),
    });

    if (!id) {
      res.status(500).json({ error: "Failed to create session" });
      return;
    }

    res.json({ id, controllerToken, passphrase });
  });

  // Turn a local session into a synced one: upload the PDF (kept in the client's
  // IndexedDB until now) and attach the authenticated owner. Requires a valid
  // Supabase access token.
  app.post("/api/sessions/:id/claim", uploadField("pdf"), async (req, res) => {
    // Local/offline mode has no auth provider, so a synced (server-hosted)
    // presentation can't have a logged-in owner. Authorize the claim with the
    // controller token the presenter's browser already holds (same model as
    // the delete route) and skip the per-user quota, which only exists to cap
    // storage on the shared hosted service.
    let userId: string | null = null;
    if (isLocalMode) {
      if (!(await loadControlledSession(supabase, req, res, "controller_token", { activeOnly: false }))) return;
    } else {
      const token = getBearerToken(req);
      if (!token) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      const { data: userData, error: userError } = await supabase.auth.getUser(token);
      if (userError || !userData.user) {
        res.status(401).json({ error: "Invalid session" });
        return;
      }
      userId = userData.user.id;
      // The session being claimed is left out, so a re-claim of the same code
      // is a no-op.
      if (!(await hasRoom(supabase, res, userId, String(req.params.id)))) return;
    }

    const file = req.file;
    if (!isPdfUpload(file)) {
      res.status(400).json({ error: "A PDF file is required" });
      return;
    }

    const { data: row, error: rowError } = await supabase
      .from("sessions")
      .select("id, local, controller_token, passphrase")
      .eq("id", req.params.id)
      .single();
    if (rowError || !row) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    if (!row.local) {
      res.status(409).json({ error: "Presentation is already synced" });
      return;
    }

    const pages = await countDeckPages(file.buffer);
    if (!pages.ok) {
      res.status(pages.status).json({ error: pages.error });
      return;
    }
    const { totalSlides } = pages;

    const pdfPath = `${row.id}.pdf`;
    const { error: uploadError } = await supabase.storage
      .from("presentations")
      .upload(pdfPath, file.buffer, { contentType: "application/pdf", upsert: true });
    if (uploadError) {
      res.status(500).json({ error: "Failed to upload PDF" });
      return;
    }

    // Preserve the presenter's current position if provided (a local session's
    // slide changes were never persisted server-side).
    const currentSlide = currentSlideField(req.body.current_slide, totalSlides);
    const { error: updateError } = await supabase
      .from("sessions")
      .update({
        local: false,
        pdf_path: pdfPath,
        total_slides: totalSlides,
        user_id: userId,
        // A shared deck should outlive the default 24h anonymous expiry so it
        // doesn't vanish mid-session; owned/hosted claims get the same TTL.
        expires_at: ownedExpiry(),
        ...(currentSlide ? { current_slide: currentSlide } : {}),
      })
      .eq("id", row.id);
    if (updateError) {
      res.status(500).json({ error: "Failed to update session" });
      return;
    }

    // No cap in local mode, so nothing to reconcile there.
    if (userId && (await overshot(supabase, userId))) {
      await supabase.storage.from("presentations").remove([pdfPath]);
      await supabase.from("sessions").update({ local: true, pdf_path: "" }).eq("id", row.id);
      res.status(403).json({ error: CAP_REACHED });
      return;
    }

    res.json({
      id: row.id,
      totalSlides,
      controllerToken: row.controller_token,
      passphrase: row.passphrase,
    });
  });
}
