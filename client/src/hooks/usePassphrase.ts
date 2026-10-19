import { useCallback, useState } from "react";
import { controllerHeaders } from "@/lib/sessionAuth";
import { getSessionAuth, setSessionAuth } from "@/lib/utils";

/**
 * The shared-control passphrase, minted on demand rather than at import: a
 * deck that is never co-presented never needs one, and a deck that was never
 * shared has no session row to hold it. Fetched (and cached) the first time
 * the presenter asks to hand out control.
 */
export function usePassphrase(id: string) {
  // Tagged with the id it was read for: sharing re-keys the deck and leaves
  // the controller mounted under the new id, where the previous deck's
  // passphrase would be wrong. Anything but a match falls back to whatever the
  // credential for the id on screen holds.
  const [cached, setCached] = useState(() => ({ id, value: getSessionAuth(id).passphrase ?? "" }));
  const passphrase = cached.id === id ? cached.value : (getSessionAuth(id).passphrase ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useCallback(async () => {
    if (passphrase || busy) return;
    setBusy(true);
    setError("");
    try {
      const stored = getSessionAuth(id);
      const headers = await controllerHeaders(id);
      const res = await fetch(`/api/sessions/${id}/passphrase`, { method: "POST", headers });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Couldn't create a passphrase");
      }
      const data = await res.json();
      setSessionAuth(id, { ...stored, passphrase: data.passphrase });
      setCached({ id, value: data.passphrase });
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Couldn't create a passphrase");
    } finally {
      setBusy(false);
    }
  }, [id, passphrase, busy]);
  return { passphrase, busy, error, request };
}
