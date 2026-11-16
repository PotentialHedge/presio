// Where media sits in the deck, read from the sidecars the presio Typst and
// LaTeX packages embed: `media-slide-{n}-{id}.json` (a box in PDF points,
// top-left origin) plus, for files, the `media-{id}.{gif|mp4|webm}` bytes,
// and for HTML animations the `media-{id}.html` entry and its
// `media-asset-…` files.
// The format is shared with the checker (src/lib/inspectAttachments.ts) and
// schema/media-sidecar.schema.json.

import { buildSrcdoc, type BundleFile } from "./bundle";

export type MediaKind = "file" | "url" | "youtube" | "vimeo" | "html";

/** Who drives an HTML animation on viewers' screens. */
export type SyncMode = "presenter" | "independent";

export interface Placement {
  slide: number;
  id: string;
  kind: MediaKind;
  mime: string;
  /** The box, as fractions of the page, top-left origin. */
  x: number;
  y: number;
  w: number;
  h: number;
  autoplay: boolean;
  loop: boolean;
  /** What a <video> or <img> loads: a blob URL for a file, the URL itself
   *  for a url. Empty for embeds, which are addressed by videoId. */
  src: string;
  /** The media's own address, for links in a downloaded PDF: a url's, or an
   *  embed's watch page. */
  url?: string;
  videoId?: string;
  filename?: string;
  /** HTML animations: the sandboxed frame's whole document (runtime, entry
   *  and assets), built on first use — only the slide surface needs it. */
  srcdoc?: () => string;
  /** Whether viewers follow the presenter or run it themselves (the author's
   *  default; the presenter can switch it live). */
  sync: SyncMode;
  /** Viewers running it themselves get play / pause / seek controls. */
  controls: boolean;
  /** Pointer input reaches the animation (sliders, buttons, dragging). */
  interactive: boolean;
  /** The box's width / height. */
  aspect: number;
  /** HTML animations: the moment (s) its poster shows; by default its end
   *  when it has a length, else two seconds in. */
  posterAt?: number;
}

/** Placements by slide; no entry = no media. */
export type Placements = Map<number, Placement[]>;

export const isVideo = (p: Placement) => p.mime.startsWith("video/");
export const isEmbed = (p: Placement) => p.kind === "youtube" || p.kind === "vimeo";
export const isHtml = (p: Placement) => p.kind === "html";
/** Has a timeline to play and pause — unlike a GIF. */
export const isPlayable = (p: Placement) => isVideo(p) || isEmbed(p) || isHtml(p);

interface Sidecar {
  slide: number;
  id: string;
  kind?: MediaKind;
  filename?: string;
  url?: string;
  video_id?: string;
  mime: string;
  x_pt: number;
  y_pt: number;
  w_pt: number;
  h_pt: number;
  autoplay: boolean;
  loop: boolean;
  assets?: { path?: unknown; filename?: unknown }[];
  sync?: string;
  controls?: boolean;
  interactive?: boolean;
  duration?: number;
  poster_at?: number;
}

const SIDECAR_RE = /^media-slide-\d+-.+\.json$/;
const BINARY_RE = /^media-.+\.(gif|mp4|webm)$/i;
// An HTML animation's entry page and the files it loads.
const HTML_FILE_RE = /^media-(?!slide-\d+-).+\.html?$|^media-asset-/i;

// Sidecars come out of the PDF, which is untrusted input — a deck can be
// handed over or downloaded from anywhere. These keep a malformed or hostile
// sidecar from producing a broken embed or an unexpected request.

// A video id is interpolated into the embed URL's path (embeds.ts), so it's
// held to the characters both providers use: no slashes or "..".
function isValidVideoId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

// A url is loaded as a <video>/<img> source, or linked from a download.
function isValidMediaUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

const mimeFor = (name: string) =>
  /\.gif$/i.test(name) ? "image/gif" : /\.mp4$/i.test(name) ? "video/mp4" : /\.webm$/i.test(name) ? "video/webm" : "application/octet-stream";

/**
 * Every slide's media in the deck on screen. File media become blob URLs of
 * this document; hand the result to release() once it's no longer shown.
 */
export async function readPlacements(): Promise<Placements> {
  const [attachments, pages] = await Promise.all([presio.deck.attachments(), presio.deck.pages()]);
  const binaries = new Map<string, string>();
  const htmlFiles = new Map<string, Uint8Array>();
  const sidecars: Sidecar[] = [];
  for (const { filename, bytes } of attachments) {
    if (HTML_FILE_RE.test(filename) && !SIDECAR_RE.test(filename)) {
      if (!htmlFiles.has(filename)) htmlFiles.set(filename, bytes);
    } else if (SIDECAR_RE.test(filename)) {
      try {
        sidecars.push(JSON.parse(new TextDecoder().decode(bytes)));
      } catch { /* skip malformed */ }
    } else if (BINARY_RE.test(filename) && !binaries.has(filename)) {
      const blob = new Blob([bytes as BlobPart], { type: mimeFor(filename) });
      binaries.set(filename, URL.createObjectURL(blob));
    }
  }

  // One document per animation, however many pages show it (an overlay
  // group repeats it on each).
  const srcdocs = new Map<string, () => string>();
  const out: Placements = new Map();
  for (const m of sidecars) {
    const page = pages[m.slide - 1];
    if (!page || !page.width || !page.height) continue;
    const kind: MediaKind = m.kind ?? (m.url ? "url" : "file");
    let src: string | undefined;
    if (kind === "youtube" || kind === "vimeo") {
      // Addressed by id; one without a usable id can't play at all.
      if (!isValidVideoId(m.video_id)) continue;
      src = "";
    } else if (kind === "url") {
      if (!isValidMediaUrl(m.url)) continue;
      src = m.url;
    } else if (kind === "html") {
      src = "";
    } else if (m.filename) {
      src = binaries.get(m.filename);
    }
    if (src === undefined) continue;
    let srcdoc: (() => string) | undefined;
    if (kind === "html") {
      if (typeof m.filename !== "string" || !htmlFiles.has(m.filename)) continue;
      const key = JSON.stringify([m.filename, m.assets, m.loop, m.duration]);
      if (!srcdocs.has(key)) {
        let built: string | undefined;
        srcdocs.set(key, () => (built ??= htmlDocument(m, htmlFiles)));
      }
      srcdoc = srcdocs.get(key);
    }
    const placement: Placement = {
      slide: m.slide,
      id: String(m.id),
      kind,
      mime: typeof m.mime === "string" ? m.mime : "",
      x: m.x_pt / page.width,
      y: m.y_pt / page.height,
      w: m.w_pt / page.width,
      h: m.h_pt / page.height,
      autoplay: !!m.autoplay,
      loop: !!m.loop,
      src,
      url: kind !== "file" && isValidMediaUrl(m.url) ? m.url : undefined,
      videoId: kind === "youtube" || kind === "vimeo" ? m.video_id : undefined,
      filename: m.filename,
      srcdoc,
      sync: m.sync === "independent" ? "independent" : "presenter",
      controls: m.controls !== false,
      interactive: m.interactive !== false,
      aspect: m.w_pt / m.h_pt,
      posterAt: typeof m.poster_at === "number" && m.poster_at >= 0 ? m.poster_at : undefined,
    };
    if (![placement.x, placement.y, placement.w, placement.h].every(Number.isFinite) || placement.w <= 0 || placement.h <= 0) continue;
    const list = out.get(m.slide) ?? [];
    list.push(placement);
    out.set(m.slide, list);
  }
  return out;
}

const TEXT_EXT = /\.(html?|m?js|css|json|svg|txt|csv|xml|glsl|frag|vert)$/i;

/** An HTML animation's frame document: its entry page and every asset the
 *  sidecar lists, by the path the page uses for it. */
function htmlDocument(m: Sidecar, files: Map<string, Uint8Array>): string {
  const entry = files.get(m.filename as string) ?? new Uint8Array();
  const bundle: Record<string, BundleFile> = { "index.html": { text: new TextDecoder().decode(entry) } };
  for (const asset of Array.isArray(m.assets) ? m.assets : []) {
    if (typeof asset?.path !== "string" || typeof asset.filename !== "string") continue;
    const bytes = files.get(asset.filename);
    if (!bytes || asset.path === "index.html") continue;
    bundle[asset.path] = TEXT_EXT.test(asset.path) ? { text: new TextDecoder().decode(bytes) } : { b64: toBase64(bytes) };
  }
  return buildSrcdoc("index.html", bundle, {
    embedded: true,
    loop: !!m.loop,
    duration: typeof m.duration === "number" && m.duration > 0 ? m.duration : undefined,
    muted: true,
  });
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Free the blob URLs of placements no longer on screen. */
export function release(placements: Placements) {
  for (const list of placements.values()) {
    for (const p of list) if (p.src.startsWith("blob:")) URL.revokeObjectURL(p.src);
  }
}
