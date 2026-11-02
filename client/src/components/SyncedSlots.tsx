import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { listAccountSynced, type RecentDeck } from "@/lib/recentDecks";
import { endSession } from "@/lib/utils";
import { track } from "@/lib/analytics";

// Shown when a share is refused because the account is at its cap of live
// synced presentations. The error alone told people to "end one" without
// saying which they had or where to do it. The one presenter we saw hit it
// tried twice, gave up, and presented locally instead. Ending one here frees
// the slot and retries the share in place.
export function SyncedSlots({ onFreed }: { onFreed: () => void }) {
  const [decks, setDecks] = useState<RecentDeck[] | null>(null);
  const [ending, setEnding] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void listAccountSynced().then((list) => {
      if (!cancelled) setDecks(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!decks?.length) return null;

  const end = async (deck: RecentDeck) => {
    setEnding(deck.id);
    setError("");
    try {
      const res = await endSession(deck.id, deck.controllerToken);
      if (!res.ok) throw new Error();
      track("cap-ended-deck");
      setDecks((list) => list?.filter((d) => d.id !== deck.id) ?? null);
      onFreed();
    } catch {
      setError("Couldn't end that presentation. Try again.");
    } finally {
      setEnding(null);
    }
  };

  return (
    <div className="w-full max-w-xs space-y-2">
      <p className="text-xs text-muted-foreground text-center">
        End one of your synced presentations to make room. Its viewers are disconnected and its code stops working.
      </p>
      <ul className="divide-y rounded-md border">
        {decks.map((deck) => (
          <li key={deck.id} className="flex items-center gap-2 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm" dir="auto">{deck.filename}</p>
              <p className="font-mono text-xs text-muted-foreground">{deck.id}</p>
            </div>
            <Button size="sm" variant="outline" disabled={ending !== null} onClick={() => end(deck)}>
              {ending === deck.id ? "Ending…" : "End"}
            </Button>
          </li>
        ))}
      </ul>
      {error && <p className="text-xs text-destructive text-center">{error}</p>}
    </div>
  );
}
