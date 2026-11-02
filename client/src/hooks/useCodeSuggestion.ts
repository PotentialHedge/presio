// "Did you mean …?" for a join code that matched nothing. Codes are read off a
// projector and typed by hand, and the usual slip is two characters swapped or
// one misread. The server knows the live codes and answers with the single one
// this is a typo away from (GET /api/sessions/:id/similar).

import { useEffect, useState } from "react";

/** While `active`, the live code `id` was probably meant to be, or null. */
export function useCodeSuggestion(id: string | undefined, active: boolean): string | null {
  const [found, setFound] = useState<{ id: string; suggestion: string } | null>(null);

  useEffect(() => {
    if (!active || !id) return;
    let cancelled = false;
    fetch(`/api/sessions/${encodeURIComponent(id)}/similar`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { suggestion: string | null } | null) => {
        if (!cancelled && body?.suggestion) setFound({ id, suggestion: body.suggestion });
      })
      .catch(() => {
        // No suggestion is the same page as before.
      });
    return () => {
      cancelled = true;
    };
  }, [id, active]);

  return active && found && found.id === id ? found.suggestion : null;
}
