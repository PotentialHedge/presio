import type { getDocument, PDFDocumentProxy } from "pdfjs-dist";
import pdfWorker from "./pdfWorker.ts?worker&url";

// pdf.js itself is loaded on first use, not at import: this module sits under
// the home page, which would otherwise parse the whole library before it can
// paint, though most visits there never open a deck.
let pdfjs: Promise<typeof import("pdfjs-dist")> | null = null;
function loadPdfjs() {
  pdfjs ??= import("pdfjs-dist").then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = pdfWorker;
    return lib;
  });
  return pdfjs;
}

type DocumentSource = Parameters<typeof getDocument>[0];

/**
 * The loading task that owns each open document.
 *
 * pdf.js v6 moved `destroy()` off PDFDocumentProxy and onto the loading task.
 * Documents are handed around this app as plain proxies — held in React state,
 * stashed in refs, prefetched and adopted later — so threading a second value
 * alongside every one of them would touch the whole presentation lifecycle.
 * Keeping the pairing here instead means callers still hold a document and say
 * destroyPdf(doc), exactly as they said doc.destroy() before.
 *
 * Weak, so a document dropped without being destroyed doesn't pin its task.
 */
const loadingTasks = new WeakMap<PDFDocumentProxy, ReturnType<typeof getDocument>>();

/** Open a PDF and remember the task that owns it. */
export async function openPdf(source: DocumentSource): Promise<PDFDocumentProxy> {
  const { getDocument } = await loadPdfjs();
  const task = getDocument(source);
  const doc = await task.promise;
  loadingTasks.set(doc, task);
  return doc;
}

/**
 * Release a document's worker. Safe to call with null/undefined, and safe to
 * call twice — both of which the prefetch paths rely on.
 */
export function destroyPdf(doc: PDFDocumentProxy | null | undefined): void {
  if (!doc) return;
  void loadingTasks.get(doc)?.destroy();
}

/** One of a deck's sidecar attachments, with its bytes resolved. */
export interface PdfAttachment {
  filename: string;
  content: Uint8Array;
  /** For a file attached to a page (a FileAttachment annotation, as LaTeX's
   *  attachfile makes) rather than to the document: its 1-based page. */
  page?: number;
  /** Where that annotation sits on its page: fractions of the page, top-left origin. */
  rect?: { x: number; y: number; w: number; h: number };
}

/** A page's file attachment annotations, as pdf.js reports them. */
async function fileAnnotations(pdf: PDFDocumentProxy, pageNum: number) {
  const page = await pdf.getPage(pageNum);
  const annotations = await page.getAnnotations();
  return { page, annotations: annotations.filter((a) => a.subtype === "FileAttachment" && a.fileId) };
}

/**
 * Whether the deck carries any sidecar attachments at all, on the document
 * or on a page.
 *
 * Separate from readAttachments() because the answer is just a count: pulling
 * every attachment's bytes to find out would fetch the whole sidecar payload
 * for a boolean.
 */
export async function hasAttachments(pdf: PDFDocumentProxy): Promise<boolean> {
  const raw = await pdf.getAttachments();
  if (raw && raw.size > 0) return true;
  for (let n = 1; n <= pdf.numPages; n++) {
    if ((await fileAnnotations(pdf, n)).annotations.length) return true;
  }
  return false;
}

/**
 * Read a deck's attachments, bytes included: the document's own, then each
 * page's in page order.
 *
 * v6 returns a Map rather than a plain object, and an entry's `content` is
 * only populated when the bytes happen to be loaded already. The old
 * `Object.keys`/`Object.values` call sites read a Map as empty, which turned a
 * deck full of notes into a deck with none — silently, because the casts they
 * used hid the change from the compiler.
 */
export async function readAttachments(pdf: PDFDocumentProxy): Promise<PdfAttachment[]> {
  const out: PdfAttachment[] = [];
  const raw = await pdf.getAttachments();
  for (const [id, entry] of raw ?? []) {
    const content = entry.content ?? (await pdf.getAttachmentContent(id));
    if (content) out.push({ filename: entry.filename ?? id, content });
  }

  for (let n = 1; n <= pdf.numPages; n++) {
    const { page, annotations } = await fileAnnotations(pdf, n);
    if (!annotations.length) continue;
    const viewport = page.getViewport({ scale: 1 });
    for (const ann of annotations) {
      const content = await pdf.getAttachmentContent(ann.fileId);
      if (!content) continue;
      // The rect is in PDF user space (bottom-left origin); the viewport flips
      // it to the top-left origin plugins' layers use.
      const [rx1, ry1, rx2, ry2] = ann.rect as [number, number, number, number];
      const [x1, y1] = viewport.convertToViewportPoint(rx1, ry1);
      const [x2, y2] = viewport.convertToViewportPoint(rx2, ry2);
      const rect = {
        x: Math.min(x1, x2) / viewport.width,
        y: Math.min(y1, y2) / viewport.height,
        w: Math.abs(x2 - x1) / viewport.width,
        h: Math.abs(y2 - y1) / viewport.height,
      };
      out.push({ filename: ann.file?.filename ?? ann.fileId, content, page: n, rect });
    }
  }
  return out;
}

// Cached *source* canvases, keyed by page+scale. These are never mounted in the
// DOM: each renderPage() call returns a fresh copy (see below). A canvas is a
// DOM node that can only live in one place, so handing the same cached element
// to multiple consumers (thumbnails, next-slide preview, the main view) made
// appending it in one spot yank it out of another — e.g. clicking a thumbnail
// whose scale collided with the main view turned the thumbnail black.
const pageCache = new Map<string, HTMLCanvasElement>();

// Which document pageCache currently holds renders for. Saving an edited deck
// (a plugin's presio.deck.save) swaps in a new PDFDocumentProxy;
// without this the next render of the same page+scale returned the *previous*
// document's canvas.
let pageCachePdf: PDFDocumentProxy | null = null;

/** Blit a cached source canvas into a new, independently-mountable canvas. */
function copyCanvas(source: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement("canvas");
  out.width = source.width;
  out.height = source.height;
  out.getContext("2d")!.drawImage(source, 0, 0);
  return out;
}

export async function loadPdf(url: string): Promise<PDFDocumentProxy> {
  // Fetch the whole file in one request rather than letting pdf.js stream it
  // with HTTP range requests. Mobile Safari/iOS mishandles cross-origin 206
  // Partial Content responses, so range-loaded PDFs that work on desktop fail
  // on iOS. Presentations are small, so a single GET is cheap and robust.
  return openPdf({ url, disableRange: true, disableStream: true });
}

export async function loadPdfData(data: Uint8Array): Promise<PDFDocumentProxy> {
  return openPdf({ data });
}

/**
 * A URL that fetches a synced deck's *current* bytes.
 *
 * A replace rewrites the stored object in place, so the deck's URL never
 * changes — and a browser (or the CDN in front of it) that already has the old
 * copy will happily serve it again. Keyed by something that changes when the
 * bytes do. Only for URLs we mint ourselves: see loadLatestPdf.
 */
export function freshPdfUrl(url: string, version: string | number): string {
  return `${url}${url.includes("?") ? "&" : "?"}v=${version}`;
}

/**
 * Load a synced deck's current bytes, whichever kind of URL it lives at.
 *
 * Our own storage URLs sit behind a CDN that keys on the full URL, so a version
 * parameter is what actually defeats it. An `external` URL belongs to whoever
 * published the deck and may be presigned, where an unknown parameter
 * invalidates the signature outright — there, `cache: "reload"` gets fresh
 * bytes without touching the URL, and needs no CORS preflight the way a
 * Cache-Control request header would.
 */
export async function loadLatestPdf(
  url: string,
  { external, version }: { external: boolean; version: string | number }
): Promise<PDFDocumentProxy> {
  if (!external) return loadPdf(freshPdfUrl(url, version));
  // One GET for the whole file, matching loadPdf's reasons for not ranging.
  const res = await fetch(url, { cache: "reload" });
  if (!res.ok) throw new Error(`Failed to fetch the PDF (${res.status})`);
  return loadPdfData(new Uint8Array(await res.arrayBuffer()));
}

// Cap the rendered canvas width (device pixels). The viewer is often the whole
// point — a projector or a 5K panel — so this has to clear those: a 5K display
// is 5120 device px, and a 4K one at DPR 2 asks for 7680. At 16:9 that is
// ~38 Mpx, well inside every desktop browser's canvas area limit. Small-screen
// devices never come near it (an iPad Pro is 2732 device px wide), so the
// tighter limits on mobile Safari are not in play.
const MAX_CANVAS_WIDTH = 8192;

export interface RenderOptions {
  // Fixed scale multiplier (used for thumbnails / previews).
  scale?: number;
  // Desired output width in device pixels. When set, the scale is derived so
  // the canvas matches the display resolution and stays crisp. Takes
  // precedence over `scale`.
  targetWidth?: number;
}

export async function renderPage(
  pdf: PDFDocumentProxy,
  pageNum: number,
  opts: number | RenderOptions = {}
): Promise<HTMLCanvasElement> {
  const options: RenderOptions = typeof opts === "number" ? { scale: opts } : opts;

  // A different document invalidates every cached canvas.
  if (pageCachePdf !== pdf) {
    pageCache.clear();
    pageCachePdf = pdf;
  }

  const page = await pdf.getPage(pageNum);
  const baseWidth = page.getViewport({ scale: 1 }).width;

  let scale: number;
  if (options.targetWidth) {
    scale = Math.min(options.targetWidth, MAX_CANVAS_WIDTH) / baseWidth;
  } else {
    scale = options.scale ?? 2;
  }
  // Quantise so small layout/DPR jitters reuse the cached canvas instead of
  // re-rendering on every resize. Round *up*: rounding to the nearest step can
  // land below the requested width, which then gets upscaled on display —
  // exactly the softness targetWidth exists to avoid.
  scale = Math.max(0.25, Math.ceil(scale * 4) / 4);

  const key = `${pageNum}-${scale}`;
  const cached = pageCache.get(key);
  if (cached) return copyCanvas(cached);

  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;

  await page.render({
    canvasContext: canvas.getContext("2d")!,
    canvas,
    viewport,
  }).promise;

  pageCache.set(key, canvas);
  return copyCanvas(canvas);
}

export function clearCache() {
  pageCache.clear();
  pageCachePdf = null;
}
