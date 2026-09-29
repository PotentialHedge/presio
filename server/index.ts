import "./instrument.js"; // must come first — initializes Sentry before other imports
import "dotenv/config";
import http from "http";
import { Server } from "socket.io";
import { supabase } from "./supabase.js";
import { createApp } from "./app.js";
import { getAllowedOrigins } from "./security.js";
import { isLocalMode } from "./local/mode.js";
import { registerSocketHandlers, createSocketState, clearSessionState } from "./socket.js";

const allowedOrigins = getAllowedOrigins();
// See app.ts's corsOrigin: development and local/LAN use have no fixed origin
// to allow ahead of time, so accept any unless ALLOWED_ORIGIN was set explicitly.
const devOrLocal = process.env.NODE_ENV === "development" || isLocalMode;
const io = new Server({
  cors: { origin: allowedOrigins.length ? allowedOrigins : devOrLocal ? true : false },
});

const socketState = createSocketState();
const app = createApp({ supabase, io, socketState });
const server = http.createServer(app);
io.attach(server);

registerSocketHandlers(io, supabase, socketState);

// --- Cleanup expired sessions (every hour) ---

async function cleanupExpired() {
  // Only pick up sessions that are still active but past their expiry; rows
  // already marked 'expired' have been handled, so skip them.
  const { data: expired } = await supabase
    .from("sessions")
    .select("id, pdf_path")
    .neq("status", "expired")
    .lt("expires_at", new Date().toISOString());

  if (!expired?.length) return;

  const paths = expired.map((s) => s.pdf_path).filter(Boolean);
  if (paths.length) await supabase.storage.from("presentations").remove(paths);

  // Mark as expired rather than deleting — the row is retained as a record.
  const ids = expired.map((s) => s.id);
  await supabase.from("sessions").update({ status: "expired" }).in("id", ids);

  // Tell any connected windows and drop them, mirroring the explicit-end
  // route. Without this a presentation that ages out mid-use just goes dead:
  // the controller's events are silently discarded once its registration is
  // cleared, with no feedback to anyone.
  for (const id of ids) {
    const sockets = await io.in(id).fetchSockets();
    for (const s of sockets) {
      s.emit("session_ended");
      s.disconnect(true);
    }
    clearSessionState(socketState, id);
  }

  console.log(`Expired ${expired.length} session(s)`);
}

// Run once at startup (the interval otherwise waits a full hour first), then
// hourly. Guard so a transient failure doesn't crash boot.
cleanupExpired().catch((err) => console.error("Initial cleanup failed:", err));
setInterval(() => {
  cleanupExpired().catch((err) => console.error("Cleanup failed:", err));
}, 60 * 60 * 1000);

// --- Start ---

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
