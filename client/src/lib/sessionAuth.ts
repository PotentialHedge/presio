// The headers that prove this browser may change a session: the controller
// token it holds, plus the signed-in owner's bearer token where accounts
// exist. The server accepts either (server/lib/sessionAccess.ts).

import { authEnabled } from "@/lib/authMode";
import { supabase } from "@/lib/supabaseClient";
import { getSessionAuth } from "@/lib/utils";

/**
 * Controller headers for session `id`. `fallbackToken` is used when this
 * browser holds no token of its own (an account deck from /api/sessions/mine
 * carries one). Throws when there's nothing to send.
 */
export async function controllerHeaders(id: string, fallbackToken?: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  const controllerToken = getSessionAuth(id).controllerToken ?? fallbackToken;
  if (controllerToken) headers["x-controller-token"] = controllerToken;
  if (authEnabled) {
    const { data } = await supabase.auth.getSession();
    const accessToken = data.session?.access_token;
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  }
  if (!Object.keys(headers).length) {
    throw new Error("This browser isn't the controller for this presentation");
  }
  return headers;
}
