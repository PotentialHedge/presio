// An HTML animation's poster: a still from the animation itself, for the
// thumbnails, Next Slide and a downloaded PDF. The page renders it (the
// runtime's snapshot, see html-runtime.js) in a sandboxed frame of its own,
// off screen at the item's shape, one animation at a time.

import type { Placement } from "./placements";

const WIDTH = 960;
const TIMEOUT_MS = 20_000;

let queue: Promise<unknown> = Promise.resolve();

/** A PNG data URL of the animation at its poster time, or null. */
export function htmlPoster(p: Placement): Promise<string | null> {
  const next = queue.then(() => snapshot(p));
  queue = next.catch(() => null);
  return next;
}

function snapshot(p: Placement): Promise<string | null> {
  const srcdoc = p.srcdoc?.();
  if (!srcdoc) return Promise.resolve(null);
  return new Promise((done) => {
    const f = document.createElement("iframe");
    f.setAttribute("sandbox", "allow-scripts");
    f.setAttribute("aria-hidden", "true");
    f.tabIndex = -1;
    const height = Math.round(WIDTH / (p.aspect > 0 ? p.aspect : 16 / 9));
    // Laid out (unlike display: none), so the page has a size to draw at.
    f.style.cssText = `position:fixed;left:-${WIDTH * 2}px;top:0;width:${WIDTH}px;height:${height}px;border:0;pointer-events:none`;
    const finish = (url: string | null) => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      f.remove();
      done(url);
    };
    const onMessage = (e: MessageEvent) => {
      if (e.source !== f.contentWindow || e.data?.presio !== "html") return;
      if (e.data.type === "ready") {
        f.contentWindow?.postMessage({ presio: "html", cmd: "snapshot", t: p.posterAt, scale: 1 }, "*");
      } else if (e.data.type === "snapshot") {
        finish(typeof e.data.url === "string" && e.data.url.startsWith("data:image/") ? e.data.url : null);
      }
    };
    const timer = setTimeout(() => finish(null), TIMEOUT_MS);
    window.addEventListener("message", onMessage);
    f.srcdoc = srcdoc;
    document.body.append(f);
  });
}
