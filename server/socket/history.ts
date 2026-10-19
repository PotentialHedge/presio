// Plugin histories over the socket (presio.history; the store is
// ../history.ts): catching up, and the controller's commits, seeds,
// snapshots and resets.

import type { Socket } from "socket.io";
import { asRecord, PLUGIN_ID_RE } from "../validation.js";
import { HistoryError, parseBase, sanitizeHead, sanitizeHistoryCommit, SHA256_RE } from "../history.js";
import { ackOf, allowAudiencePluginEvent, controllerOnly } from "./guards.js";
import type { SocketDeps } from "./state.js";

const isPluginId = (v: unknown): v is string => typeof v === "string" && PLUGIN_ID_RE.test(v);

export function historyHandlers({ io, state }: SocketDeps) {
  const { controllers, history } = state;

  return (socket: Socket) => {
    // Anyone in the session may catch up on a history: a device sends the
    // head it has and gets what it's missing. Viewers are throttled like
    // their plugin messages; they only sync on joining or after a gap.
    socket.on("history_sync", async (raw: unknown, ack?: (reply: unknown) => void) => {
      const { sessionId } = socket.data;
      if (typeof ack !== "function") return;
      const r = asRecord(raw);
      const head = sanitizeHead(r.head);
      if (!sessionId || !isPluginId(r.plugin) || !head) return ack({ error: "Bad request" });
      if (controllers.get(sessionId) !== socket.id && !allowAudiencePluginEvent(socket)) return ack({ error: "Too many requests" });
      try {
        ack(await history.sync(sessionId, r.plugin, head));
      } catch (err) {
        console.warn("history_sync failed:", err);
        ack({ error: "Couldn't read the history" });
      }
    });

    // The controller's edits: ordered here, then sent to everyone in the
    // session, the sender included — that's how it learns the entry's place.
    socket.on("history_commit", controllerOnly(controllers, socket, async (sessionId, raw: unknown, ack?: unknown) => {
      const reply = ackOf(ack);
      const commit = sanitizeHistoryCommit(raw);
      if (!commit) return reply({ error: "Bad commit" });
      try {
        const entry = await history.commit(sessionId, commit);
        if (entry) io.to(sessionId).emit("history_entry", { plugin: commit.plugin, entry });
        reply({ ok: true });
      } catch (err) {
        reply({ error: err instanceof HistoryError ? err.message : "Couldn't save the edit" });
        if (!(err instanceof HistoryError)) console.warn("history_commit failed:", err);
      }
    }));

    // A deck shared with edits already on it: the controller's copy becomes
    // the session's, from a seed blob it uploaded first.
    socket.on("history_seed", controllerOnly(controllers, socket, async (sessionId, raw: unknown, ack?: unknown) => {
      const reply = ackOf(ack);
      const r = asRecord(raw);
      if (!isPluginId(r.plugin) || typeof r.sha !== "string" || !SHA256_RE.test(r.sha)) {
        return reply({ error: "Bad seed" });
      }
      try {
        const seeded = await history.seed(sessionId, r.plugin, r.sha);
        if (seeded) socket.to(sessionId).emit("history_reset", { plugin: r.plugin });
        reply({ ok: seeded });
      } catch (err) {
        console.warn("history_seed failed:", err);
        reply({ ok: false });
      }
    }));

    // The controller took a snapshot: the log may start from it.
    socket.on("history_snapshot", controllerOnly(controllers, socket, async (sessionId, raw: unknown, ack?: unknown) => {
      const reply = ackOf(ack);
      const r = asRecord(raw);
      const base = parseBase(r.base);
      if (!isPluginId(r.plugin) || !base?.snapshot) return reply({ ok: false });
      try {
        reply({ ok: await history.snapshot(sessionId, r.plugin, { seq: base.seq, hash: base.hash, sha: base.snapshot }) });
      } catch (err) {
        console.warn("history_snapshot failed:", err);
        reply({ ok: false });
      }
    }));

    // A different deck: start the plugin's history afresh, everywhere.
    socket.on("history_reset", controllerOnly(controllers, socket, async (sessionId, raw: unknown) => {
      const r = asRecord(raw);
      if (!isPluginId(r.plugin)) return;
      try {
        await history.reset(sessionId, r.plugin);
        socket.to(sessionId).emit("history_reset", { plugin: r.plugin });
      } catch (err) {
        console.warn("history_reset failed:", err);
      }
    }));
  };
}
