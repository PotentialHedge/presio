// Remote republish watching for URL-backed decks. A deck loaded from an
// external link re-fetches its PDF on every load, so a republish at the same
// URL is only invisible to a session that is already running. The controller
// polls the server's cheap metadata endpoint (one poller per session — viewers
// never poll) and, when the remote file provably changed, offers the new deck.
// Same house rule as the file watcher: nothing swaps until the presenter
// clicks, and nothing surfaces when the host is unreachable or doesn't support
// the check.

import type { PDFDocumentProxy } from "pdfjs-dist";
import { destroyPdf, loadLatestPdf } from "@/lib/pdf";

const BASE_MS = 30_000;
const MAX_MS = 4 * 60_000;

interface Sig {
  etag: string;
  lastModified: string;
  contentLength: string;
}

const same = (a: Sig, b: Sig) =>
  a.etag === b.etag && a.lastModified === b.lastModified && a.contentLength === b.contentLength;
const hasValidators = (s: Sig) => !!(s.etag || s.lastModified || s.contentLength);

/**
 * Polls `/api/sessions/:id/remote-version` until stopped. On a confirmed
 * change it loads the new document and hands it over (the caller owns it from
 * then on). Returns stop().
 */
export function watchRemoteDeck(opts: {
  sessionId: string;
  /** The deck's own URL, re-fetched past any cache on a change. */
  pdfUrl: string;
  /** Controller headers; a throw means there's no credential to poll with. */
  headers: () => Promise<Record<string, string>>;
  onUpdate: (doc: PDFDocumentProxy) => void;
}): () => void {
  let stopped = false;
  let busy = false; // a poll's probes + parse can outlast one interval; never overlap
  let backedOff = false; // parked at the slow cadence by an unreachable host
  let delay = BASE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let baseline: Sig | null = null;
  let candidate: Sig | null = null;

  const stop = () => {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => { void poll(); }, delay);
  };

  const poll = async () => {
    if (stopped || busy) return;
    // Frozen background tabs can't present anyway; skip the round without
    // spending a request on the remote host.
    if (document.hidden) {
      schedule();
      return;
    }
    busy = true;
    try {
      let headers: Record<string, string>;
      try {
        headers = await opts.headers();
      } catch {
        stop(); // no credential to poll with — degrade silently
        return;
      }
      let sig: Sig;
      try {
        const res = await fetch(`/api/sessions/${opts.sessionId}/remote-version`, { headers });
        if (res.status === 403 || res.status === 404) {
          stop(); // session gone, or not URL-backed: nothing to watch
          return;
        }
        if (!res.ok) {
          // Remote host unreachable (the server answers 502): back off to
          // the slowest cadence and keep trying, still silently.
          delay = MAX_MS;
          backedOff = true;
          schedule();
          return;
        }
        sig = await res.json();
        if (backedOff) {
          // The host answered again. Without this the session stays parked at
          // the four-minute cadence for good, since only a confirmed change
          // resets it — and it can't see one while the host is down.
          backedOff = false;
          delay = BASE_MS;
        }
      } catch {
        stop(); // network failure — today's behaviour, without errors
        return;
      }
      if (!hasValidators(sig)) {
        stop(); // host sends no validators — there is nothing to compare
        return;
      }
      if (!baseline) {
        baseline = sig; // first observation is the reference, never a change
        schedule();
        return;
      }
      if (same(sig, baseline)) {
        candidate = null;
        delay = Math.min(delay * 2, MAX_MS); // polite backoff while unchanged
        schedule();
        return;
      }
      // Different from the baseline. Hosts behind some CDNs mint a fresh
      // ETag per request, so require the new signature to hold steady
      // across two consecutive polls before trusting it.
      if (!candidate || !same(sig, candidate)) {
        candidate = sig;
        schedule();
        return;
      }
      // Confirmed change: read the new document's page count before
      // offering it, so applying clamps correctly. A parse failure means
      // the publish is probably mid-flight — keep watching silently and
      // re-detect on the next poll.
      candidate = null;
      try {
        // Always external here: the server only answers remote-version for a
        // deck backed by someone else's URL.
        const doc = await loadLatestPdf(opts.pdfUrl, { external: true, version: Date.now() });
        if (stopped) {
          destroyPdf(doc);
          return;
        }
        baseline = sig;
        delay = BASE_MS; // stay fast for a while after a real change
        opts.onUpdate(doc);
      } catch {
        // candidate stays null: the next poll re-confirms and retries.
      }
      schedule();
    } finally {
      busy = false;
    }
  };

  schedule();
  return stop;
}
