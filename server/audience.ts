import type { Server, Socket } from "socket.io";
import {
  AUDIENCE_KEY_RE,
  AudienceSlots,
  ChangeBatcher,
  VIEWER_ID_RE,
  type AudienceJoin,
  type AudienceKeyState,
} from "../shared/plugin/audience.js";
import { PLUGIN_ID_RE, type PublishedPlugin } from "./validation.js";

// presio.audience: each viewer's input, one slot per viewer under each key a
// plugin opened, held here per session and plugin (in memory, like retained
// plugin state). Viewers write their own slot; the presenter opens, closes and
// clears keys, and hears about writes in batches with a summary computed here,
// so a big room stays cheap. The presenter's page mirrors the slots and
// re-seeds them after a server restart.
//
// Viewers identify themselves with an anonymous id their browser keeps for the
// session, so a reconnect keeps its slot. It's for slotting only: nothing here
// trusts it beyond "this is the slot to write".

export interface AudienceState {
  /** Slots per session, per plugin. */
  slots: Map<string, Map<string, AudienceSlots>>;
  /** Writes waiting to reach the presenter, by session, plugin and key. */
  batcher: ChangeBatcher | null;
  /** Sessions whose slots a seed added to since the last pull: their viewers re-join. */
  seeded: Set<string>;
}

export function createAudienceState(): AudienceState {
  return { slots: new Map(), batcher: null, seeded: new Set() };
}

export function clearAudience(state: AudienceState, sessionId: string) {
  state.slots.delete(sessionId);
  state.seeded.delete(sessionId);
  state.batcher?.drop(`${sessionId}\u0000`);
}

interface Deps {
  io: Server;
  state: AudienceState;
  controllers: Map<string, string>;
  publishedPlugins: Map<string, Map<string, PublishedPlugin>>;
  /** The audience's shared rate limit for plugin traffic. */
  allow(socket: Socket): boolean;
}

type Ack = (reply: unknown) => void;

const asRecord = (raw: unknown): Record<string, unknown> =>
  typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};

export function registerAudienceHandlers(socket: Socket, deps: Deps) {
  const { io, state, controllers, publishedPlugins } = deps;
  // One batcher for the process: its flush finds the session's controller.
  const batcher = (state.batcher ??= new ChangeBatcher((batch, changes) => {
    const [sessionId, plugin, key] = batch.split("\u0000");
    const slots = state.slots.get(sessionId)?.get(plugin);
    const controller = controllers.get(sessionId);
    // No controller: it pulls everything when it re-joins.
    if (!slots || !controller) return;
    io.to(controller).emit("audience_update", { plugin, key, summary: slots.summary(key), changes });
  }));

  const slotsOf = (sessionId: string, plugin: string) => {
    const bySession = state.slots.get(sessionId) ?? new Map<string, AudienceSlots>();
    state.slots.set(sessionId, bySession);
    let slots = bySession.get(plugin);
    if (!slots) {
      slots = new AudienceSlots();
      bySession.set(plugin, slots);
    }
    return slots;
  };

  // Only a plugin the presenter published, and that asks for the "audience"
  // permission in the manifest it published, has slots.
  const audiencePlugin = (sessionId: string, plugin: unknown): string | null => {
    if (typeof plugin !== "string" || !PLUGIN_ID_RE.test(plugin)) return null;
    const published = publishedPlugins.get(sessionId)?.get(plugin);
    return published?.manifest.permissions.includes("audience") ? plugin : null;
  };
  const NOT_PUBLISHED = "That plugin isn't published to viewers with the \"audience\" permission";

  const isController = (sessionId: string | undefined): sessionId is string =>
    !!sessionId && controllers.get(sessionId) === socket.id;

  // --- Viewers ---

  // A viewer (re)joining: remember its id, and give back each audience
  // plugin's key states and its own values.
  socket.on("audience_join", (raw: unknown, ack?: Ack) => {
    if (typeof ack !== "function") return;
    const { sessionId } = socket.data;
    const viewer = asRecord(raw).viewer;
    if (!sessionId || typeof viewer !== "string" || !VIEWER_ID_RE.test(viewer)) return ack({ error: "Bad request" });
    if (!deps.allow(socket)) return ack({ error: "Too many requests" });
    socket.data.viewerId = viewer;
    const plugins: AudienceJoin = {};
    for (const [plugin, slots] of state.slots.get(sessionId) ?? []) {
      if (!audiencePlugin(sessionId, plugin)) continue;
      plugins[plugin] = { keys: slots.keyStates(), mine: slots.mine(viewer) };
    }
    ack({ plugins });
  });

  // A viewer's write to its own slot (null removes it).
  socket.on("audience_set", (raw: unknown, ack?: Ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const { sessionId, viewerId } = socket.data;
    if (!sessionId) return reply({ error: "Not in a session" });
    if (isController(sessionId)) return reply({ error: "The presenter has no slot of their own" });
    if (typeof viewerId !== "string") return reply({ error: "Not joined to the audience yet" });
    const r = asRecord(raw);
    const plugin = audiencePlugin(sessionId, r.plugin);
    if (!plugin) return reply({ error: NOT_PUBLISHED });
    if (typeof r.key !== "string" || !AUDIENCE_KEY_RE.test(r.key)) return reply({ error: "A key is 1–64 letters, digits or _ . : -" });
    if (!deps.allow(socket)) return reply({ error: "Too many answers at once: try again in a moment" });
    const value = r.value === undefined ? null : r.value;
    const error = slotsOf(sessionId, plugin).write(r.key, viewerId, value);
    if (error) return reply({ error });
    batcher.add(`${sessionId}\u0000${plugin}\u0000${r.key}`, viewerId, value);
    reply({ ok: true });
  });

  // --- The presenter ---

  const presenterKey = (raw: unknown, reply: Ack): { sessionId: string; plugin: string; key: string } | null => {
    const { sessionId } = socket.data;
    if (!isController(sessionId)) {
      reply({ error: "Only the presenter can do that" });
      return null;
    }
    const r = asRecord(raw);
    const plugin = audiencePlugin(sessionId, r.plugin);
    if (!plugin) {
      reply({ error: NOT_PUBLISHED });
      return null;
    }
    if (typeof r.key !== "string" || !AUDIENCE_KEY_RE.test(r.key)) {
      reply({ error: "A key is 1–64 letters, digits or _ . : -" });
      return null;
    }
    return { sessionId, plugin, key: r.key };
  };

  for (const [event, open] of [["audience_open", true], ["audience_close", false]] as const) {
    socket.on(event, (raw: unknown, ack?: Ack) => {
      const reply = typeof ack === "function" ? ack : () => {};
      const target = presenterKey(raw, reply);
      if (!target) return;
      const { sessionId, plugin, key } = target;
      if (slotsOf(sessionId, plugin).setOpen(key, open)) socket.to(sessionId).emit("audience_state", { plugin, key, open });
      reply({ ok: true });
    });
  }

  socket.on("audience_clear", (raw: unknown, ack?: Ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const target = presenterKey(raw, reply);
    if (!target) return;
    const { sessionId, plugin, key } = target;
    slotsOf(sessionId, plugin).clear(key);
    socket.to(sessionId).emit("audience_cleared", { plugin, key });
    reply({ ok: true });
  });

  // The presenter's mirror, after a server restart or a controller re-join:
  // keys the server lacks come in whole, and values it has no slot for are
  // added; what it has wins. Sent in parts when big (a socket message is at
  // most 1 MB), so only the slots are merged.
  socket.on("audience_seed", (raw: unknown, ack?: Ack) => {
    const reply = typeof ack === "function" ? ack : () => {};
    const { sessionId } = socket.data;
    if (!isController(sessionId)) return reply({ error: "Only the presenter can do that" });
    const r = asRecord(raw);
    const plugin = audiencePlugin(sessionId, r.plugin);
    if (!plugin) return reply({ error: NOT_PUBLISHED });
    const slots = slotsOf(sessionId, plugin);
    let changed = false;
    for (const [key, keyState] of Object.entries(asRecord(r.keys))) {
      if (!AUDIENCE_KEY_RE.test(key) || typeof keyState !== "object" || keyState === null) continue;
      if (slots.merge(key, keyState as AudienceKeyState)) changed = true;
    }
    if (changed) state.seeded.add(sessionId);
    reply({ ok: true });
  });

  // Everything the server holds for a plugin, for the presenter's mirror to
  // adopt. It ends a re-seed: viewers re-join, to get back what it restored.
  socket.on("audience_pull", (raw: unknown, ack?: Ack) => {
    if (typeof ack !== "function") return;
    const { sessionId } = socket.data;
    if (!isController(sessionId)) return ack({ error: "Only the presenter can do that" });
    const plugin = audiencePlugin(sessionId, asRecord(raw).plugin);
    if (!plugin) return ack({ error: NOT_PUBLISHED });
    if (state.seeded.delete(sessionId)) socket.to(sessionId).emit("audience_resync");
    ack({ keys: slotsOf(sessionId, plugin).toJSON() });
  });
}
