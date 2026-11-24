// The headers that prove this browser may change a session: the controller
// token it holds, plus the signed-in owner's bearer token where accounts
// exist. The server accepts either (server/lib/sessionAccess.ts).

import { authEnabled } from "@/lib/authMode";
import { supabase } from "@/lib/supabaseClient";
import { getSessionAuth, setSessionAuth } from "@/lib/utils";

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

/**
 * Sign this browser in as session `id`'s controller with its shared-control
 * passphrase, storing the controller token it hands back. Throws with the
 * server's reason when the passphrase is wrong.
 */
export async function signInWithPassphrase(id: string, passphrase: string): Promise<void> {
  const res = await fetch(`/api/sessions/${id}/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passphrase }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Authentication failed");
  }
  const data = await res.json();
  setSessionAuth(id, { controllerToken: data.controllerToken, passphrase: data.passphrase });
}

// --- Controller links ---
//
// A controller link carries the passphrase in its fragment
// (/s/ABC123?role=controller#pass=XYZ), so opening it signs that device in
// instead of landing it on a viewer (issue #172). The fragment never reaches
// the server's logs or a Referer header, and the page drops it from the
// address bar as soon as it has read it.

const PASS_PARAM = "pass";

/** The controller link for `origin`, carrying `passphrase` when there is one. */
export function controllerLink(origin: string, id: string, passphrase?: string): string {
  const base = `${origin}/s/${id}?role=controller`;
  return passphrase ? `${base}#${PASS_PARAM}=${encodeURIComponent(passphrase)}` : base;
}

/** The passphrase the controller link this page was opened from brought, if any. */
export function readLinkPassphrase(): string | null {
  if (typeof window === "undefined" || !window.location.hash) return null;
  return new URLSearchParams(window.location.hash.slice(1)).get(PASS_PARAM) || null;
}

/** Take the passphrase back out of the address bar, once read. */
export function clearLinkPassphrase() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  if (!params.has(PASS_PARAM)) return;
  params.delete(PASS_PARAM);
  const rest = params.toString();
  const { pathname, search } = window.location;
  window.history.replaceState(window.history.state, "", `${pathname}${search}${rest ? `#${rest}` : ""}`);
}
