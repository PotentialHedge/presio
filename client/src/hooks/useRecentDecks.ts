import { useEffect, useState } from "react";
import { listRecentDecks, type RecentDeck } from "@/lib/recentDecks";

/**
 * The recents list, re-read whenever `refresh` changes (an upload finishing)
 * and when the user signs in or out — signing in pulls the account's decks in,
 * signing out drops back to local-only.
 */
export function useRecentDecks(refresh: unknown, userId: string | undefined) {
  const [recents, setRecents] = useState<RecentDeck[]>([]);
  useEffect(() => {
    let cancelled = false;
    void listRecentDecks().then((decks) => {
      if (!cancelled) setRecents(decks);
    });
    return () => {
      cancelled = true;
    };
  }, [refresh, userId]);
  return [recents, setRecents] as const;
}
