// A still image ("poster") for each item: what Next Slide and the thumbnails
// show, what sits under a player while it loads, and what a downloaded PDF
// gets baked in. An embed puts only its watch URL on the page itself, so
// without one those places show a raw youtube.com/watch?v=… line.

import { htmlPoster } from "./html-poster";
import { isHtml, isVideo, type Placement } from "./placements";

const cache = new Map<string, Promise<string | null>>();
const htmlCache = new WeakMap<() => string, Map<string, Promise<string | null>>>();

/** The item's poster URL (https: or data:), or null when there's none to be had. */
export function poster(p: Placement): Promise<string | null> {
  // An animation's: per document (a reloaded deck builds new ones), moment
  // and shape.
  const store = isHtml(p) && p.srcdoc ? (htmlCache.get(p.srcdoc) ?? htmlCache.set(p.srcdoc, new Map()).get(p.srcdoc)!) : cache;
  const key = isHtml(p) ? `${p.posterAt ?? ""}:${p.aspect.toFixed(3)}` : `${p.kind}:${p.videoId ?? p.src}`;
  let hit = store.get(key);
  if (!hit) {
    hit = resolve(p).catch(() => null);
    store.set(key, hit);
  }
  return hit;
}

function resolve(p: Placement): Promise<string | null> {
  // hqdefault always exists; maxresdefault isn't guaranteed.
  if (p.kind === "youtube") return Promise.resolve(`https://img.youtube.com/vi/${p.videoId}/hqdefault.jpg`);
  if (p.kind === "vimeo") return vimeoThumbnail(p.videoId!);
  // An animation draws its own, at its poster time.
  if (isHtml(p)) return htmlPoster(p);
  // A GIF's first frame, so previews hold still.
  if (p.mime === "image/gif") return firstFrame(p.src);
  if (p.mime.startsWith("image/")) return Promise.resolve(p.src);
  // A video file from the PDF is at hand, so its opening frame is cheap; one
  // on the web would mean downloading it here too.
  if (isVideo(p) && p.kind === "file") return videoFrame(p.src);
  return Promise.resolve(null);
}

async function vimeoThumbnail(id: string): Promise<string | null> {
  const res = await fetch(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(`https://vimeo.com/${id}`)}`);
  if (!res.ok) return null;
  const data = (await res.json()) as { thumbnail_url?: unknown };
  return typeof data.thumbnail_url === "string" ? data.thumbnail_url : null;
}

function toDataUrl(source: CanvasImageSource, width: number, height: number): string {
  const canvas = document.createElement("canvas");
  canvas.width = width || 1;
  canvas.height = height || 1;
  canvas.getContext("2d")!.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

// An image drawn once to a canvas is its first frame. A cross-origin one that
// doesn't allow reading taints the canvas; then the image itself will do.
function firstFrame(url: string): Promise<string | null> {
  return new Promise((done) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        done(toDataUrl(img, img.naturalWidth, img.naturalHeight));
      } catch {
        done(url);
      }
    };
    img.onerror = () => done(null);
    img.src = url;
  });
}

function videoFrame(url: string): Promise<string | null> {
  return new Promise((done) => {
    const v = document.createElement("video");
    const finish = (result: string | null) => {
      clearTimeout(timeout);
      v.removeAttribute("src");
      v.load();
      done(result);
    };
    const timeout = setTimeout(() => finish(null), 10_000);
    v.muted = true;
    v.preload = "auto";
    v.onloadeddata = () => {
      try {
        finish(toDataUrl(v, v.videoWidth, v.videoHeight));
      } catch {
        finish(null);
      }
    };
    v.onerror = () => finish(null);
    v.src = url;
  });
}
