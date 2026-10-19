// The session API (/api/sessions/*, /api/present), by concern:
//
//   handoff.ts — POST /api/present and the /start/:id handoff into a browser
//   sync.ts    — sharing a local deck (create, claim, external) and the
//                account's list of synced ones
//   deck.ts    — reading a session, and replacing or refreshing its deck
//   access.ts  — the passphrase, controller sign-in, and ending a session

import type express from "express";
import type { Server } from "socket.io";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { SocketState } from "../../socket/index.js";
import { registerHandoffRoutes } from "./handoff.js";
import { registerSyncRoutes } from "./sync.js";
import { registerDeckRoutes } from "./deck.js";
import { registerAccessRoutes } from "./access.js";

export interface RouteDeps {
  supabase: SupabaseClient;
  io: Server;
  socketState?: SocketState;
}

export { MAX_CONCURRENT_PRESENTATIONS } from "./sync.js";

export function registerSessionRoutes(app: express.Express, deps: RouteDeps) {
  registerHandoffRoutes(app, deps);
  // Before deck.ts: GET /api/sessions/mine must win over /api/sessions/:id.
  registerSyncRoutes(app, deps);
  registerDeckRoutes(app, deps);
  registerAccessRoutes(app, deps);
}
