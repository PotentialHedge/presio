import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import type { DeckWatchMode, DeckWatchStatus } from "@/lib/deckWatcher";
import { PresioLogo } from "@/components/PresioLogo";
import { ConnectionIndicator } from "@/components/ConnectionIndicator";
import { DeckControl } from "@/components/controller/DeckControl";

// Shared top bar for both the desktop and mobile controller. The right-hand
// `actions` slot is where the two surfaces differ: a button toolbar on desktop,
// a hamburger menu trigger on mobile.
export function ControllerHeader({
  id,
  local,
  blanked = false,
  compact = false,
  filename = "",
  deckWatchMode = null,
  deckWatchStatus,
  onReplaceDeck,
  onDropDeck,
  onDeckWatchModeChange,
  onDeckWatchApply,
  onDeckWatchResume,
  remoteDeckUpdate = false,
  onRemoteDeckApply,
  onCodeClick,
  status,
  actions,
}: {
  id: string;
  local: boolean;
  blanked?: boolean;
  /** The deck on screen. Shown (and clickable, to swap it) whenever the
   * controller passes a replace handler. */
  filename?: string;
  /** Live-reload preference, or null when this deck can't be watched (a synced
   * deck, or a browser without the File System Access API). */
  deckWatchMode?: DeckWatchMode | null;
  /** Deck file watching status (lib/deckWatcher). */
  deckWatchStatus?: DeckWatchStatus | null;
  onReplaceDeck?: () => void;
  /** A PDF dropped onto the deck name — same swap, without the picker. */
  onDropDeck?: (file: File, handle?: FileSystemFileHandle) => void;
  onDeckWatchModeChange?: (mode: DeckWatchMode) => void;
  onDeckWatchApply?: () => void;
  onDeckWatchResume?: () => void;
  /** A URL-backed deck's source PDF was republished — offer the new version. */
  remoteDeckUpdate?: boolean;
  onRemoteDeckApply?: () => void;
  /** Tighter spacing + bare code (no "Code:" label) for the mobile header. */
  compact?: boolean;
  /** Clicking the session code (opens the share dialog). */
  onCodeClick?: () => void;
  /** Plugins' status items, just before the actions. */
  status?: ReactNode;
  actions?: ReactNode;
}) {
  const deck = onReplaceDeck && onDeckWatchModeChange && onDeckWatchApply && onDeckWatchResume && (
    <DeckControl
      filename={filename}
      mode={deckWatchMode}
      status={deckWatchStatus ?? null}
      remoteUpdate={remoteDeckUpdate}
      onReplace={onReplaceDeck}
      onDropDeck={onDropDeck}
      onSetMode={onDeckWatchModeChange}
      onApply={onDeckWatchApply}
      onResume={onDeckWatchResume}
      onRemoteApply={onRemoteDeckApply}
    />
  );

  return (
    <div
      className={cn(
        "relative border-b py-2 flex items-center gap-2",
        compact ? "px-3" : "px-4"
      )}
    >
      {/* Three columns, the outer two sharing the leftover width equally, so
          the deck name sits on the middle of the bar rather than wherever its
          neighbours happen to leave it. Both sides shrink (and truncate)
          before the deck does. */}
      <div className={cn("flex min-w-0 flex-1 items-center", compact ? "gap-2" : "gap-3")}>
        <Link
          to="/"
          className="flex shrink-0 items-center gap-1.5 text-sm font-semibold hover:text-muted-foreground transition-colors"
        >
          <PresioLogo className="h-4 w-auto" />
          {/* Below ~640px the wordmark is the first thing to go: the logo
              already says where you are, and the deck name needs the width. */}
          <span className="hidden sm:inline">Presio</span>
        </Link>
        <span className="hidden text-muted-foreground/40 sm:inline">|</span>
        {!local && (
          <button
            type="button"
            onClick={onCodeClick}
            disabled={!onCodeClick}
            title="Share"
            className="flex shrink-0 items-baseline gap-1.5 rounded-md hover:text-muted-foreground transition-colors disabled:pointer-events-none"
          >
            {!compact && <span className="hidden text-xs text-muted-foreground lg:inline">Code:</span>}
            <span className={cn("font-mono font-bold tracking-widest", compact && "text-sm")}>{id}</span>
          </button>
        )}
        <ConnectionIndicator local={local} />
        {local && (
          <span className="text-xs font-medium text-amber-600 dark:text-amber-500">Local</span>
        )}
        {blanked && (
          <span className="text-xs font-medium text-destructive px-1.5 py-0.5 rounded bg-destructive/10">
            Blanked
          </span>
        )}
      </div>
      {/* Wide desktop pins the deck to the centre of the bar itself, so it
          can't drift as the code or the badges change width — out of flow, so
          the wrapper can't swallow clicks meant for the clusters underneath,
          and only the control itself takes pointer events. Narrower than that
          the columns do the centring instead, which keeps the deck off its
          neighbours when the bar gets tight. */}
      {deck && (
        <div className="flex min-w-0 justify-center lg:pointer-events-none lg:absolute lg:left-1/2 lg:-translate-x-1/2">
          <div className="min-w-0 lg:pointer-events-auto">{deck}</div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 items-center justify-end gap-1">
        {status}
        {actions}
      </div>
    </div>
  );
}
