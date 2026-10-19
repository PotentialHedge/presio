// Replacing the PDF of a deck the server hosts, keeping its id, code,
// controller token and passphrase. POST /api/sessions/:id/pdf and
// POST /api/present's update mode both land here.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Server } from "socket.io";
import { forgetDeckRetained, type SocketState } from "../socket/index.js";

/** The current slide, kept within a deck of `totalSlides`. */
export function clampSlide(current: number | null | undefined, totalSlides: number): number {
  return Math.min(Math.max(current ?? 1, 1), totalSlides);
}

/**
 * The deck changed: forget what plugins retained for the old one (drawings,
 * keyed by slide number) and tell everyone in the room, who reload it live.
 */
export function announceDeck(
  { io, socketState }: { io?: Server; socketState?: SocketState },
  sessionId: string,
  deck: { filename: string; totalSlides: number },
): void {
  if (socketState) forgetDeckRetained(socketState, sessionId);
  io?.to(sessionId).emit("deck_updated", deck);
}

/**
 * Overwrites the PDF at the row's object path and records the new page count
 * (and title, when given), with the current slide clamped into range.
 */
export async function replaceHostedPdf(
  supabase: SupabaseClient,
  row: { id: string; pdf_path: string; current_slide: number | null },
  upload: { buffer: Buffer; totalSlides: number; filename?: string },
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const { error: uploadError } = await supabase.storage
    .from("presentations")
    .upload(row.pdf_path, upload.buffer, { contentType: "application/pdf", upsert: true });
  if (uploadError) return { ok: false, status: 500, error: "Failed to save PDF" };

  const { error: updateError } = await supabase
    .from("sessions")
    .update({
      total_slides: upload.totalSlides,
      current_slide: clampSlide(row.current_slide, upload.totalSlides),
      ...(upload.filename ? { filename: upload.filename } : {}),
    })
    .eq("id", row.id);
  if (updateError) return { ok: false, status: 500, error: "Failed to update session" };
  return { ok: true };
}
