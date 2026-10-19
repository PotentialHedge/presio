import type { SupabaseClient } from "@supabase/supabase-js";
import type { Server } from "socket.io";
import { nanoid } from "nanoid";
import { countDeckPages } from "./pdfDoc.js";
import { safeEqual } from "../auth.js";
import type { SocketState } from "../socket/index.js";
import { announceDeck, clampSlide, replaceHostedPdf } from "./hostedDeck.js";
import { deckTitle } from "./upload.js";
import { generatePassphrase, insertSession, ownedExpiry } from "./sessionRows.js";

export const PRESENT_NEXT =
  "Open url in a browser to start a local presentation (skips share). The PDF is copied into the browser and removed from the server. Unclaimed links expire after 24h (7 days when authenticated).";

export type PresentResult =
  | { ok: true; id: string; url: string; filename: string; totalSlides: number; next: string; controllerToken: string }
  | { ok: false; status: number; error: string };

/** Stage a PDF for local handoff; returns an open URL the browser claims into IndexedDB. */
export async function createPresentHandoff(
  supabase: SupabaseClient,
  opts: { buffer: Buffer; originalName: string; userId: string | null; baseUrl: string }
): Promise<PresentResult> {
  const pages = await countDeckPages(opts.buffer);
  if (!pages.ok) return pages;
  const { totalSlides } = pages;

  const filename = deckTitle(opts.originalName) || "presentation";
  const controllerToken = nanoid(24);
  const passphrase = generatePassphrase();
  const pdfPath = `handoff/${nanoid(32)}.pdf`;

  const id = await insertSession(supabase, {
    pdf_path: pdfPath,
    filename,
    total_slides: totalSlides,
    controller_token: controllerToken,
    passphrase,
    local: true,
    user_id: opts.userId,
    ...(opts.userId ? { expires_at: ownedExpiry() } : {}),
  });
  if (!id) return { ok: false, status: 500, error: "Failed to create session" };

  const { error: uploadError } = await supabase.storage
    .from("presentations")
    .upload(pdfPath, opts.buffer, { contentType: "application/pdf", upsert: false });
  if (uploadError) {
    console.error("Failed to stage PDF:", uploadError);
    await supabase.from("sessions").update({ status: "expired" }).eq("id", id);
    return { ok: false, status: 500, error: "Failed to upload PDF" };
  }

  const url = `${opts.baseUrl}/start/${id}?t=${controllerToken}`;
  return {
    ok: true,
    id,
    url,
    filename,
    totalSlides,
    next: PRESENT_NEXT,
    controllerToken,
  };
}

export function handoffTokenFrom(req: { get(name: string): string | undefined; query: Record<string, unknown> }): string {
  return req.get("x-controller-token") || (typeof req.query.t === "string" ? req.query.t : "") || "";
}

export const PRESENT_UPDATED_NEXT =
  "Deck replaced in place — same link, same presentation. Open url again to hand off the new slides.";

// Synced decks have no handoff step: viewers reload the new bytes themselves,
// and `url` is the shared viewer link, not a `?t=` handoff link.
export const PRESENT_SYNCED_UPDATED_NEXT =
  "Deck replaced in place — same link, same presentation. Anyone viewing it reloads the new slides automatically.";

export type PresentUpdateResult =
  | { ok: true; id: string; url: string; filename: string; totalSlides: number; next: string }
  | { ok: false; status: number; error: string };

/**
 * Replace an existing presentation's deck in place, keeping its id, code,
 * controller token and passphrase, so the same link keeps working and no
 * additional concurrent-presentation slot is used.
 *
 * Two kinds of session land here:
 *
 *   - Local handoff sessions (as created by POST /api/present): the new bytes
 *     are re-staged under the same session so the same /start/:id?t=… link
 *     claims the replacement into a browser.
 *   - Synced hosted sessions: the PDF is overwritten at the stored object path
 *     and viewers in the room get `deck_updated` so they reload live (same
 *     semantics as POST /api/sessions/:id/pdf).
 *
 * Authorization is by controller token only — agent-facing callers never hold
 * a Supabase session, so owner-based authorization doesn't apply here.
 */
export async function updatePresentDeck(
  supabase: SupabaseClient,
  opts: {
    sessionId: string;
    token: string;
    buffer: Buffer;
    originalName?: string;
    baseUrl: string;
    io?: Server;
    socketState?: SocketState;
  }
): Promise<PresentUpdateResult> {
  const { data: row, error } = await supabase
    .from("sessions")
    .select("id, local, pdf_path, filename, current_slide, controller_token")
    .eq("id", opts.sessionId)
    .neq("status", "expired")
    // `status` is only reconciled by the hourly sweeper in index.ts, so a row
    // past its expiry can still read as active. Check the timestamp too, or an
    // update revives a presentation the API documents as gone.
    .gt("expires_at", new Date().toISOString())
    .single();
  if (error || !row) {
    return { ok: false, status: 404, error: "Presentation not found or expired" };
  }
  if (!safeEqual(opts.token, row.controller_token)) {
    return { ok: false, status: 403, error: "Not authorized" };
  }

  const pages = await countDeckPages(opts.buffer);
  if (!pages.ok) return pages;
  const { totalSlides } = pages;

  // An empty name means "keep the current title" rather than resetting it.
  const rawName = deckTitle(opts.originalName ?? "");
  const filename = rawName || row.filename || "presentation";
  // Keep the presenter near where they were; drawings keyed by slide number
  // beyond the new count become stale just as with the notes replace path.
  const clampedSlide = clampSlide(row.current_slide, totalSlides);

  if (row.local) {
    // Handoff may already be complete (the browser cleared the server copy),
    // in which case restage under a fresh path — the link revives with the new deck.
    const pdfPath = row.pdf_path || `handoff/${nanoid(32)}.pdf`;
    const { error: uploadError } = await supabase.storage
      .from("presentations")
      .upload(pdfPath, opts.buffer, { contentType: "application/pdf", upsert: true });
    if (uploadError) {
      console.error("Failed to stage updated PDF:", uploadError);
      return { ok: false, status: 500, error: "Failed to upload PDF" };
    }
    const { error: updateError } = await supabase
      .from("sessions")
      .update({ pdf_path: pdfPath, total_slides: totalSlides, current_slide: clampedSlide, filename })
      .eq("id", row.id);
    if (updateError) {
      return { ok: false, status: 500, error: "Failed to update presentation" };
    }
    const url = `${opts.baseUrl}/start/${row.id}?t=${row.controller_token}`;
    return { ok: true, id: row.id, url, filename, totalSlides, next: PRESENT_UPDATED_NEXT };
  }

  if (!row.pdf_path) {
    return { ok: false, status: 400, error: "This presentation's PDF is not hosted on the server" };
  }
  const replaced = await replaceHostedPdf(supabase, row, { buffer: opts.buffer, totalSlides, filename: rawName ? filename : undefined });
  if (!replaced.ok) return replaced;

  // Everyone in the room reloads the new bytes live, as with any other replacement.
  announceDeck(opts, row.id, { filename, totalSlides });

  return {
    ok: true,
    id: row.id,
    url: `${opts.baseUrl}/s/${row.id}`,
    filename,
    totalSlides,
    next: PRESENT_SYNCED_UPDATED_NEXT,
  };
}
