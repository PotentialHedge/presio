// A viewer left on an ended session follows the presenter to the new one.
//
// Presenters restart mid-meeting: they re-upload a fixed deck, move on to the
// next agenda item's deck, or end a session by mistake. Each restart mints a
// new code, and the room is still holding the old one. The server knows which
// live session (if any) the same owner started since
// (GET /api/sessions/:id/next), so a viewer page that finds its session gone
// keeps asking for a while and moves over by itself once there is an answer.

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { track } from "@/lib/analytics";

const POLL_MS = 10_000;
/** Stop asking eventually: a room that's been empty this long has gone home. */
const GIVE_UP_MS = 45 * 60 * 1000;

/**
 * While `active`, polls for the ended session `id`'s successor and navigates
 * there when one appears. Returns whether the session is known to have ended
 * (false while unknown, or for a code the server never issued).
 */
export function useSessionSuccessor(id: string | undefined, active: boolean): boolean {
  const navigate = useNavigate();
  // Keyed by id, so following to the next session doesn't carry this over.
  const [endedId, setEndedId] = useState<string | null>(null);

  useEffect(() => {
    if (!active || !id) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const startedAt = Date.now();

    const poll = async () => {
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/next`);
        // Unknown code: nothing will ever succeed it.
        if (res.status === 404) return;
        if (res.ok) {
          const body: { ended: boolean; next: string | null } = await res.json();
          if (cancelled) return;
          setEndedId(body.ended ? id : null);
          if (body.next) {
            track("session-followed", { waitedS: Math.round((Date.now() - startedAt) / 1000) });
            navigate(`/s/${body.next}`, { replace: true });
            return;
          }
        }
      } catch {
        // Offline for a moment; try again on the next tick.
      }
      if (!cancelled && Date.now() - startedAt < GIVE_UP_MS) timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id, active, navigate]);

  return endedId !== null && endedId === id;
}
