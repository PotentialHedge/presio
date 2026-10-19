// Loading a session row for a request that acts on it, and checking that the
// caller may: the controller token, or (hosted mode, where routes allow it)
// the signed-in owner.

import type express from "express";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveOptionalUserId, safeEqual } from "../auth.js";
import { isLocalMode } from "../local/mode.js";

/** The controller token a request carries. */
export const controllerTokenOf = (req: express.Request): string => req.get("x-controller-token") || "";

interface LoadOptions {
  /** Also accept the signed-in owner (hosted mode only). Default false. */
  owner?: boolean;
  /** Treat an expired session as missing. Default true. */
  activeOnly?: boolean;
  /** The token to check, when it isn't the x-controller-token header. */
  token?: string;
}

/**
 * The session `req.params.id` names, when the caller controls it; otherwise
 * answers 404 or 403 and returns null. `columns` must include controller_token
 * (and user_id with `owner`).
 */
// The client is untyped, so rows are too; callers name the columns they read.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadControlledSession<Row = any>(
  supabase: SupabaseClient,
  req: express.Request,
  res: express.Response,
  columns: string,
  { owner = false, activeOnly = true, token = controllerTokenOf(req) }: LoadOptions = {},
): Promise<Row | null> {
  const userId = owner && !isLocalMode ? await resolveOptionalUserId(supabase, req) : null;
  const query = supabase.from("sessions").select(columns).eq("id", req.params.id);
  const { data: row, error } = await (activeOnly ? query.neq("status", "expired") : query).single();
  if (error || !row) {
    res.status(404).json({ error: "Session not found" });
    return null;
  }
  const r = row as unknown as { controller_token: string; user_id?: string | null };
  const authorized = safeEqual(token, r.controller_token) || (!!userId && r.user_id === userId);
  if (!authorized) {
    res.status(403).json({ error: "Not authorized" });
    return null;
  }
  return row as Row;
}
