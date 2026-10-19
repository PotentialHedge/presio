import { RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatRecentDate, type RecentDeck } from "@/lib/recentDecks";

export function RecentDeckList({
  recents,
  busy,
  onOpen,
  onReplace,
  onClose,
}: {
  recents: RecentDeck[];
  /** Whether a replace or a close is underway (their buttons wait). */
  busy: { replacing: boolean; closing: boolean };
  onOpen: (deck: RecentDeck) => void;
  onReplace: (deck: RecentDeck) => void;
  onClose: (deck: RecentDeck) => void;
}) {
  if (recents.length === 0) return null;
  return (
    <div className="mt-8">
      <div className="mb-2 font-mono text-xs uppercase tracking-wide text-muted-foreground">
        Recent presentations
      </div>
      <ul className="space-y-1.5">
        {recents.map((r) => (
          // The open action is its own button rather than a
          // clickable row: nesting Replace/Close inside a
          // `role="button"` row is invalid ARIA, and Enter/Space on
          // an inner button would activate both it and the row.
          <li
            key={r.id}
            className="flex items-center gap-2 rounded-md border px-3 py-2 transition-colors focus-within:border-muted-foreground/50 hover:border-muted-foreground/50"
          >
            <button
              type="button"
              aria-label={`Open ${r.filename}`}
              onClick={() => onOpen(r)}
              className="min-w-0 flex-1 cursor-pointer rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--home2-accent)]"
            >
              <p className="truncate text-sm font-medium">{r.filename}</p>
              <p className="text-xs text-muted-foreground">
                {r.totalSlides} {r.totalSlides === 1 ? "slide" : "slides"}
                {" · "}
                <span
                  className={r.kind === "local" ? undefined : "text-(--home2-accent)"}
                >
                  {r.kind === "local" ? "local" : r.kind === "synced" ? "shared" : "synced"}
                </span>
                {r.createdAt !== null && ` · ${formatRecentDate(r.createdAt)}`}
              </p>
            </button>
            <Button
              size="sm"
              variant="ghost"
              title="Swap in a recompiled PDF — keeps this presentation's code"
              disabled={busy.replacing}
              onClick={() => onReplace(r)}
            >
              <RefreshCw size={14} />
              Replace
            </Button>
            <Button
              size="sm"
              variant="ghost"
              title={
                r.kind === "local"
                  ? "Delete this presentation from this browser — cannot be undone"
                  : "End this presentation for everyone — cannot be undone"
              }
              disabled={busy.closing}
              onClick={() => onClose(r)}
            >
              <X size={14} />
              Close
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
