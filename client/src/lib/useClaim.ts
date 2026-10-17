import { useState } from "react";
import { idbGet, idbDelete } from "@/lib/localStore";
import { isLocalDeckId } from "@/lib/localId";
import { supabase } from "@/lib/supabaseClient";
import { authEnabled } from "@/lib/authMode";
import { useAuth } from "@/lib/useAuth";
import { getSessionAuth, setSessionAuth } from "@/lib/utils";
import { lsRemove, sessionKey, rekeySessionStorage } from "@/lib/storage";
import { rekeyHistories } from "@/lib/plugins/historyDb";
import { MAX_PDF_BYTES, MAX_PDF_MB } from "@/lib/limits";
import { track } from "@/lib/analytics";

// Shares a deck that until now lived only in this browser: the PDF is uploaded
// and the session becomes a normal synced one. Two shapes of local deck exist,
// and they differ in whether a `sessions` row already reserves a code:
//
//   - Imported here (offline-capable path): no row, no code — the id is a
//     browser-local one (lib/localId.ts). Sharing creates the row server-side,
//     which is where the real join code is minted, so the deck is *re-keyed*.
//   - Staged by POST /api/present (the agent handoff): the row and code already
//     exist, and sharing claims that row under the same id.
//
// Returns the id the deck is now reachable at — the same one for a claim, a
// brand new code when the deck was re-keyed — or null on failure.
export function useClaim(id: string) {
  const { session } = useAuth();
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");

  const sync = async (currentSlide?: number): Promise<string | null> => {
    // Local/offline mode has no accounts: authorize with the controller token
    // this browser stored when the session was created (handoff decks only —
    // a deck imported here has no server row to be the controller of yet), and
    // skip the Supabase session entirely.
    if (authEnabled && !session) {
      // We may appear "logged in" without a real Supabase session — notably the
      // dev-only VITE_DEV_USER flag fakes a user but never establishes a session,
      // and the server's claim endpoint requires a real access token. Surface that
      // instead of silently doing nothing when the button is clicked.
      setSyncError("You're not fully signed in. Please log in again to sync.");
      return null;
    }
    setSyncError("");
    setSyncing(true);
    try {
      // A deck that was never registered has no row to claim: creating one is
      // what mints its code (server-side, through the collision-retrying
      // insert — no id is proposed from here).
      const registering = isLocalDeckId(id);

      let authHeaders: Record<string, string>;
      if (authEnabled) {
        // Pull a fresh token rather than the cached session's: getSession()
        // auto-refreshes if it's near expiry, so the claim never fails with a
        // stale 401.
        const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
        if (sessionError || !sessionData.session) throw new Error("Please log in again");
        authHeaders = { Authorization: `Bearer ${sessionData.session.access_token}` };
      } else if (registering) {
        // Nothing to authorize against yet — this request is what creates the
        // session, and the token it returns is what proves control afterwards.
        authHeaders = {};
      } else {
        const { controllerToken } = getSessionAuth(id);
        if (!controllerToken) throw new Error("This browser isn't the controller for this presentation");
        authHeaders = { "x-controller-token": controllerToken };
      }

      const rec = await idbGet(id);
      if (!rec) throw new Error("Local copy not found on this device");
      if (rec.blob.size > MAX_PDF_BYTES) throw new Error(`This PDF is over the ${MAX_PDF_MB} MB upload limit`);
      const form = new FormData();
      form.append("pdf", rec.blob, `${rec.filename}.pdf`);
      if (registering) form.append("filename", rec.filename);
      if (currentSlide) form.append("current_slide", String(currentSlide));
      const res = await fetch(registering ? "/api/sessions" : `/api/sessions/${id}/claim`, {
        method: "POST",
        headers: authHeaders,
        body: form,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Failed to sync presentation");
      }
      const data = await res.json();
      const newId: string = data.id ?? id;
      if (data.controllerToken) {
        setSessionAuth(newId, { controllerToken: data.controllerToken, passphrase: data.passphrase });
      }
      if (newId !== id) {
        // Re-key: everything keyed by the old id has to follow it, or the
        // presenter loses their drawings the moment they share.
        rekeySessionStorage(id, newId);
        await rekeyHistories(id, newId).catch((e) => console.warn("Couldn't move the deck's plugin histories:", e));
        lsRemove(sessionKey(id));
        // A viewer window may already be open on the old id. Its record is
        // about to disappear, so tell it — over the channel it is still
        // listening on — where the deck moved to, rather than leaving it
        // staring at a presentation that no longer resolves.
        try {
          const channel = new BroadcastChannel(`presio-${id}`);
          channel.postMessage({ type: "rekeyed", payload: { id: newId } });
          channel.close();
        } catch {
          // No BroadcastChannel (or it's blocked): nothing to notify.
        }
      }
      await idbDelete(id).catch(() => { /* ignore */ });
      track("go-online", { ok: true, registering });
      return newId;
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : "Failed to sync presentation";
      track("go-online", { ok: false, error: message });
      setSyncError(message);
      return null;
    } finally {
      setSyncing(false);
    }
  };

  return { syncing, syncError, sync };
}
