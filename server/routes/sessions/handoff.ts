// POST /api/present, and the handoff it starts: the browser that opens the
// returned /start/:id link downloads the staged PDF into IndexedDB, then has
// the server copy removed.

import type express from "express";
import { resolveOptionalUserId } from "../../auth.js";
import { baseUrl } from "../../lib/baseUrl.js";
import { createPresentHandoff, handoffTokenFrom, updatePresentDeck } from "../../lib/presentHandoff.js";
import { loadControlledSession } from "../../lib/sessionAccess.js";
import { isPdfUpload, singleField, uploadField } from "../../lib/upload.js";
import type { RouteDeps } from "./index.js";

/**
 * A filename as header values: they must be Latin-1, so a CJK or emoji name
 * would make Node throw. X-Filename is percent-encoded (Start.tsx decodes it);
 * Content-Disposition has an ASCII fallback plus the RFC 6266 filename* form.
 */
function filenameHeaders(filename: string): { disposition: string; encoded: string } {
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return { disposition: `attachment; filename="${ascii}.pdf"; filename*=UTF-8''${encoded}.pdf`, encoded };
}

export function registerHandoffRoutes(app: express.Express, { supabase, io, socketState }: RouteDeps) {
  /**
   * POST /api/present — upload a PDF; get a URL that opens a local presentation
   * (skips share). The PDF is staged briefly, then moved into the browser.
   *
   *   curl -s -F file=@deck.pdf https://presio.ch/api/present
   *   # open the returned url
   *
   * Update mode: pass `session_id` (multipart field) plus its controller token
   * (`controller_token` field or `x-controller-token` header) to replace an
   * existing presentation's deck instead of creating one — the response keeps
   * the same id/link and no extra concurrent slot is used.
   */
  app.post("/api/present", uploadField("file"), async (req, res) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'Missing "file" field (multipart/form-data)' });
      return;
    }
    if (!isPdfUpload(file, { byName: true })) {
      res.status(400).json({ error: "File must be a PDF" });
      return;
    }

    const rawSessionId = singleField(req.body.session_id);
    const rawToken = singleField(req.body.controller_token);
    if (rawSessionId === null || rawToken === null) {
      res.status(400).json({
        error: 'Send "session_id" and "controller_token" at most once each',
      });
      return;
    }

    const sessionId = rawSessionId.trim();
    if (sessionId) {
      // The token is compared byte-for-byte, so it is never trimmed.
      const token = rawToken || req.get("x-controller-token") || "";
      if (!token) {
        // Reject rather than falling back to create: silently minting a new
        // presentation would hand the agent a fresh link and consume a slot.
        res.status(401).json({
          error: 'A controller token is required to update an existing presentation ("controller_token" field or "x-controller-token" header)',
        });
        return;
      }
      const result = await updatePresentDeck(supabase, {
        sessionId,
        token,
        buffer: file.buffer,
        originalName: file.originalname,
        baseUrl: baseUrl(req),
        io,
        socketState,
      });
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json({
        id: result.id,
        url: result.url,
        filename: result.filename,
        totalSlides: result.totalSlides,
        next: result.next,
        updated: true,
      });
      return;
    }

    const userId = await resolveOptionalUserId(supabase, req);
    const result = await createPresentHandoff(supabase, {
      buffer: file.buffer,
      originalName: file.originalname,
      userId,
      baseUrl: baseUrl(req),
    });
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json({
      id: result.id,
      url: result.url,
      filename: result.filename,
      totalSlides: result.totalSlides,
      next: result.next,
    });
  });

  // Download a staged handoff PDF (token required). Does not delete yet.
  app.get("/api/sessions/:id/handoff", async (req, res) => {
    const row = await loadControlledSession(supabase, req, res, "id, local, pdf_path, controller_token, filename, total_slides", {
      token: handoffTokenFrom(req),
    });
    if (!row) return;
    if (!row.local || !row.pdf_path) {
      res.status(410).json({ error: "Handoff already completed or unavailable" });
      return;
    }

    const { data: blob, error } = await supabase.storage.from("presentations").download(row.pdf_path);
    if (error || !blob) {
      res.status(404).json({ error: "PDF not found" });
      return;
    }
    const buf = Buffer.from(await blob.arrayBuffer());
    const { disposition, encoded } = filenameHeaders(row.filename);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", disposition);
    res.setHeader("X-Filename", encoded);
    res.setHeader("X-Total-Slides", String(row.total_slides));
    res.send(buf);
  });

  // After the browser has stored the PDF in IndexedDB, clear the server copy.
  app.post("/api/sessions/:id/handoff/complete", async (req, res) => {
    const row = await loadControlledSession(supabase, req, res, "id, local, pdf_path, controller_token", {
      token: handoffTokenFrom(req),
    });
    if (!row) return;
    if (!row.local) {
      res.status(409).json({ error: "Not a local handoff session" });
      return;
    }
    if (row.pdf_path) {
      await supabase.storage.from("presentations").remove([row.pdf_path]);
      await supabase.from("sessions").update({ pdf_path: "" }).eq("id", row.id);
    }
    res.json({ ok: true });
  });
}
