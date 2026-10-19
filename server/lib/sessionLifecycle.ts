// Ending a presentation, the one way: by its controller (DELETE
// /api/sessions/:id) or by the hourly sweep of expired ones (index.ts).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Server } from "socket.io";
import { clearSessionState, type SocketState } from "../socket.js";

/**
 * Removes the sessions' PDFs, marks them expired (the rows are kept as a
 * record), and tells every window still connected before dropping it. Without
 * the last step a presentation that ends mid-use just goes dead: the
 * controller's events are silently discarded once its registration is cleared,
 * with no feedback to anyone.
 */
export async function endSessions(
  { supabase, io, socketState }: { supabase: SupabaseClient; io: Server; socketState?: SocketState },
  sessions: { id: string; pdf_path: string | null }[],
): Promise<void> {
  if (!sessions.length) return;
  const paths = sessions.map((s) => s.pdf_path).filter((p): p is string => !!p);
  if (paths.length) await supabase.storage.from("presentations").remove(paths);
  await supabase.from("sessions").update({ status: "expired" }).in("id", sessions.map((s) => s.id));

  for (const { id } of sessions) {
    const sockets = await io.in(id).fetchSockets();
    for (const s of sockets) {
      s.emit("session_ended");
      s.disconnect(true);
    }
    if (socketState) clearSessionState(socketState, id);
  }
}
