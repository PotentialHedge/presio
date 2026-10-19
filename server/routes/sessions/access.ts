// Who controls a session: the shared-control passphrase, signing in with it,
// and the controller ending the session.

import type express from "express";
import { safeEqual } from "../../auth.js";
import { loadControlledSession } from "../../lib/sessionAccess.js";
import { endSessions } from "../../lib/sessionLifecycle.js";
import { generatePassphrase } from "../../lib/sessionRows.js";
import type { RouteDeps } from "./index.js";

export function registerAccessRoutes(app: express.Express, { supabase, io, socketState }: RouteDeps) {
  // Mint — or hand back — the shared-control passphrase. It is created on first
  // need rather than at session creation: most decks are never co-presented,
  // and a deck that was never shared has no row to hold one. Same
  // authorization as the other presenter-side writes: the controller token
  // this browser holds, or (hosted only) the logged-in owner.
  app.post("/api/sessions/:id/passphrase", async (req, res) => {
    const row = await loadControlledSession(supabase, req, res, "id, controller_token, passphrase, user_id", { owner: true });
    if (!row) return;

    if (row.passphrase) {
      res.json({ passphrase: row.passphrase });
      return;
    }

    const passphrase = generatePassphrase();
    const { error } = await supabase.from("sessions").update({ passphrase }).eq("id", row.id);
    if (error) {
      res.status(500).json({ error: "Failed to create passphrase" });
      return;
    }
    res.json({ passphrase });
  });

  app.post("/api/sessions/:id/auth", async (req, res) => {
    const { passphrase } = req.body;
    if (!passphrase) {
      res.status(400).json({ error: "Passphrase is required" });
      return;
    }

    const { data, error } = await supabase
      .from("sessions")
      .select("controller_token, passphrase")
      .eq("id", req.params.id)
      .neq("status", "expired")
      .single();

    if (error || !data) {
      res.status(404).json({ error: "Session not found" });
      return;
    }

    // An unminted passphrase (created on demand — see the route above) must
    // never match anything, however the caller shapes the request.
    if (!data.passphrase || typeof passphrase !== "string" || !safeEqual(data.passphrase, passphrase)) {
      res.status(401).json({ error: "Invalid passphrase" });
      return;
    }

    res.json({ controllerToken: data.controller_token, passphrase: data.passphrase });
  });

  // Only the controller (who holds the token) may end a presentation.
  app.delete("/api/sessions/:id", async (req, res) => {
    const row = await loadControlledSession(supabase, req, res, "id, pdf_path, controller_token", { activeOnly: false });
    if (!row) return;
    await endSessions({ supabase, io, socketState }, [row]);
    res.json({ ok: true });
  });
}
