// How long opening a presentation takes, reported to Umami as one
// `deck-load` event per opened deck. Each stage is ms since the load began:
//
//   open    the PDF is parsed and its page count known (download included)
//   paint   the first slide is on screen — the number a presenter feels
//   extras  links and attachment detection are read (the annotation scan)
//
// plus, for a page that was loaded straight onto the presentation URL,
// `fromNav`: navigation start to first paint, which adds the app's own
// bundle and pdf.js to the picture. An in-app navigation leaves it out, since
// that time was spent on whatever page came before.
//
// A deck swapped in mid-talk (replace, recompile) isn't a load and isn't
// timed. Neither is a load that never reaches every stage — a failed open
// reports itself as `presentation-error` instead.

import { track } from "./analytics";

type Stage = "open" | "paint" | "extras";

/** Whether this document was loaded directly onto the current URL. */
function cameStraightHere(): boolean {
  try {
    const nav = performance.getEntriesByType("navigation")[0];
    return !!nav && new URL(nav.name).pathname === location.pathname;
  } catch {
    return false;
  }
}

/** A size bucket, so the report groups decks rather than listing every byte count. */
function sizeBucket(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  if (mb < 1) return "<1MB";
  if (mb < 5) return "1-5MB";
  if (mb < 20) return "5-20MB";
  if (mb < 50) return "20-50MB";
  return "50MB+";
}

export class DeckLoadTimer {
  private readonly start = performance.now();
  private readonly marks: Partial<Record<Stage, number>> = {};
  private info: Record<string, unknown> = {};
  private role: string | null = null;
  private sent = false;

  /** Record a stage. Only its first occurrence counts. */
  mark(stage: Stage): void {
    if (this.marks[stage] !== undefined) return;
    this.marks[stage] = Math.round(performance.now() - this.start);
    if (stage === "paint" && cameStraightHere()) {
      this.info.fromNav = Math.round(performance.now());
    }
    this.flush();
  }

  /** What was loaded: local or server, page count, file size. */
  describe(mode: "local" | "server", slides: number, bytes: number): void {
    Object.assign(this.info, { mode, slides, bytes, size: sizeBucket(bytes) });
    this.flush();
  }

  /** The role once the session settles it (see Presentation's settledRole). */
  settle(role: string): void {
    this.role = role;
    this.flush();
  }

  private flush(): void {
    const { open, paint, extras } = this.marks;
    if (this.sent || open === undefined || paint === undefined || extras === undefined) return;
    if (!this.role || !this.info.mode) return;
    this.sent = true;
    track("deck-load", { role: this.role, open, paint, extras, ...this.info });
  }
}
