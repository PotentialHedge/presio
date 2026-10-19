// The live session over Socket.IO, by concern:
//
//   state.ts   — what the server keeps per live session
//   guards.ts  — throttles and the controller-only guard
//   session.ts — joining, slides, blanking
//   plugins.ts — plugins' publishing, settings, messages and presence
//   history.ts — plugin histories (presio.history)
//
// and presio.audience in ../audience.ts.

import type { Server } from "socket.io";
import type { SupabaseClient } from "@supabase/supabase-js";
import { registerAudienceHandlers } from "../audience.js";
import type { HistoryBucket } from "../history.js";
import { allowAudiencePluginEvent } from "./guards.js";
import { historyHandlers } from "./history.js";
import { pluginHandlers, pluginPresence } from "./plugins.js";
import { sessionHandlers } from "./session.js";
import type { SocketState } from "./state.js";

export { clearSessionState, createSocketState, forgetDeckRetained, type SocketState } from "./state.js";

export function registerSocketHandlers(io: Server, supabase: SupabaseClient, state: SocketState) {
  state.history.setBucket(supabase.storage.from("presentations") as unknown as HistoryBucket);

  const deps = { io, supabase, state };
  const presence = pluginPresence(deps);
  const handlers = [sessionHandlers(deps, presence), pluginHandlers(deps, presence), historyHandlers(deps)];

  io.on("connection", (socket) => {
    for (const register of handlers) register(socket);
    registerAudienceHandlers(socket, {
      io,
      state: state.audience,
      controllers: state.controllers,
      publishedPlugins: state.publishedPlugins,
      allow: allowAudiencePluginEvent,
    });
  });
}
