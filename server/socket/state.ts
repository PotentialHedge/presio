// The server's in-memory state for live sessions, and the operations on it
// that routes need too (ending a session, replacing its deck).

import type { Server } from "socket.io";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MAX_PLUGINS_PER_SESSION,
  MAX_RETAINED_PER_PLUGIN,
  MAX_RETAINED_BYTES_PER_PLUGIN,
  type PublishedPlugin,
  type Retain,
} from "../validation.js";
import { clearAudience, createAudienceState, type AudienceState } from "../audience.js";
import { HistoryStore } from "../history.js";

// A presenter plugin message kept for viewers who join later (the plugin's
// current "state of the world": which poll is open, whether the join code is
// up, what's drawn on each slide).
export interface RetainedPluginEvent {
  plugin: string;
  type: string;
  payload: unknown;
  /** true for the session, "deck" until the deck is replaced. */
  retain: Exclude<Retain, false>;
  /** The payload's size as JSON, for the per-plugin budget. */
  size: number;
}

export interface SocketState {
  // Which socket is the controller for each session.
  controllers: Map<string, string>;
  // Blanked state per session (transient, no DB persistence).
  blankedSessions: Set<string>;
  // The plugins the controller published for viewers to run (where to load
  // each and its hash), per session.
  publishedPlugins: Map<string, Map<string, PublishedPlugin>>;
  // Retained presenter plugin messages per session, keyed plugin + type.
  pluginRetained: Map<string, Map<string, RetainedPluginEvent>>;
  // The presenter's settings for each plugin, which viewers run with.
  pluginSettings: Map<string, Map<string, Record<string, unknown>>>;
  // Plugins' edit histories (presio.history) and their blobs, per session.
  history: HistoryStore;
  // Each viewer's input to plugins (presio.audience, see audience.ts).
  audience: AudienceState;
}

export function createSocketState(): SocketState {
  return {
    controllers: new Map(),
    blankedSessions: new Set(),
    publishedPlugins: new Map(),
    pluginRetained: new Map(),
    pluginSettings: new Map(),
    history: new HistoryStore(),
    audience: createAudienceState(),
  };
}

// Drop a session's transient socket state (on end / expiry).
export function clearSessionState(state: SocketState, sessionId: string) {
  state.controllers.delete(sessionId);
  state.blankedSessions.delete(sessionId);
  state.publishedPlugins.delete(sessionId);
  state.pluginRetained.delete(sessionId);
  state.pluginSettings.delete(sessionId);
  clearAudience(state.audience, sessionId);
  void state.history.drop(sessionId).catch((err) => console.warn(`Couldn't drop the history of session ${sessionId}:`, err));
}

// The session's deck was replaced: forget what plugins retained for the old
// one (retain: "deck" — e.g. drawings, keyed by slide number). The presenter's
// page does the same when it swaps the deck in.
export function forgetDeckRetained(state: SocketState, sessionId: string) {
  const retained = state.pluginRetained.get(sessionId);
  if (!retained) return;
  for (const [key, event] of retained) {
    if (event.retain === "deck") retained.delete(key);
  }
}

/** What each group of handlers is given. */
export interface SocketDeps {
  io: Server;
  supabase: SupabaseClient;
  state: SocketState;
}

// Keep (or, for a null payload, forget) a presenter's retained message,
// within its plugin's budget: MAX_RETAINED_PER_PLUGIN types, and
// MAX_RETAINED_BYTES_PER_PLUGIN of payload. Over budget it's still relayed
// live, just not kept for late joiners.
export function retainPluginEvent(state: SocketState, sessionId: string, event: RetainedPluginEvent) {
  const retained = state.pluginRetained.get(sessionId) ?? new Map<string, RetainedPluginEvent>();
  const key = `${event.plugin}\u0000${event.type}`;
  if (event.payload === null) {
    retained.delete(key);
    return;
  }
  const plugins = new Set<string>();
  let count = 0;
  let bytes = 0;
  for (const [k, e] of retained) {
    plugins.add(e.plugin);
    if (e.plugin !== event.plugin || k === key) continue;
    count++;
    bytes += e.size;
  }
  if (!plugins.has(event.plugin) && plugins.size >= MAX_PLUGINS_PER_SESSION) return;
  if (count >= MAX_RETAINED_PER_PLUGIN || bytes + event.size > MAX_RETAINED_BYTES_PER_PLUGIN) return;
  retained.set(key, event);
  state.pluginRetained.set(sessionId, retained);
}
