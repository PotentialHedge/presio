import type { getDocument, PDFDocumentProxy, PDFPageProxy, PDFWorker } from "pdfjs-dist";
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

/**
 * One worker for every document, started as soon as a page knows it will open
 * one (see preloadPdf). Spinning a worker up means fetching and parsing pdf.js's
 * largest script, which otherwise only began once the deck's bytes were in
 * hand — and again for every deck swapped in later. A worker handed to
 * getDocument outlives the documents' loading tasks, so destroyPdf still frees
 * a document without taking the worker down with it.
 */
let sharedWorker: PDFWorker | null = null;
async function loadWorker(): Promise<PDFWorker> {
  const lib = await loadPdfjs();
  if (!sharedWorker || sharedWorker.destroyed) sharedWorker = new lib.PDFWorker();
  return sharedWorker;
}

/** Start loading pdf.js and its worker ahead of the first openPdf(). */
export function preloadPdf(): void {
  void loadWorker().catch(() => { /* openPdf surfaces the failure */ });
}

type DocumentSource = Exclude<Parameters<typeof getDocument>[0], string | URL | ArrayBuffer | ArrayBufferView>;

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
  const [{ getDocument }, worker] = await Promise.all([loadPdfjs(), loadWorker()]);
  const task = getDocument({ ...source, worker });
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

/**
 * Resolves once a page of this document has been painted (see renderPage).
 *
 * Reading every page's annotations queues one request per page on the same
 * worker that renders, and on a long deck that queue sat in front of the
 * first slide. Background scans wait on this instead — or on a short timeout,
 * for a document nobody renders.
 */
const firstPaints = new WeakMap<PDFDocumentProxy, { done: Promise<void>; resolve: () => void }>();
function firstPaint(pdf: PDFDocumentProxy) {
  let entry = firstPaints.get(pdf);
  if (!entry) {
    let resolve!: () => void;
    const done = new Promise<void>((r) => { resolve = r; });
    entry = { done, resolve };
    firstPaints.set(pdf, entry);
  }
  return entry;
}
const FIRST_PAINT_WAIT_MS = 1500;

/** How many pages a scan has in flight at once: enough to hide the worker
 *  round trip, few enough that a slide change doesn't queue behind the rest. */
const SCAN_CONCURRENCY = 4;

export interface PageAnnotations {
  page: PDFPageProxy;
  // pdf.js types annotation data loosely.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  annotations: any[];
}

/**
 * Every page's annotations, in page order, read once per document.
 *
 * Links, attachment detection and plugins' attachments all need this, and
 * each used to walk the whole document on its own.
 */
const annotationScans = new WeakMap<PDFDocumentProxy, Promise<PageAnnotations[]>>();
export function pageAnnotations(pdf: PDFDocumentProxy): Promise<PageAnnotations[]> {
  let scan = annotationScans.get(pdf);
  if (!scan) {
    scan = (async () => {
      await Promise.race([
        firstPaint(pdf).done,
        new Promise((r) => setTimeout(r, FIRST_PAINT_WAIT_MS)),
      ]);
      const out: PageAnnotations[] = new Array(pdf.numPages);
      let next = 1;
      const work = async () => {
        while (next <= pdf.numPages) {
          const n = next++;
          const page = await pdf.getPage(n);
          out[n - 1] = { page, annotations: await page.getAnnotations() };
        }
      };
      await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, pdf.numPages) }, work));
      return out;
    })();
    annotationScans.set(pdf, scan);
  }
  return scan;
}

/** Each page's file attachment annotations (LaTeX's attachfile makes these). */
async function fileAnnotations(pdf: PDFDocumentProxy) {
  return (await pageAnnotations(pdf)).map(({ page, annotations }) => ({
    page,
    annotations: annotations.filter((a) => a.subtype === "FileAttachment" && a.fileId),
  }));
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
  return (await fileAnnotations(pdf)).some((p) => p.annotations.length > 0);
}

/**
 * Every attachment's filename, document's then pages', without their bytes —
 * all that deciding which plugins a deck activates needs.
 */
export async function attachmentNames(pdf: PDFDocumentProxy): Promise<string[]> {
  const raw = await pdf.getAttachments();
  const names = [...(raw ?? [])].map(([id, entry]) => entry.filename ?? id);
  for (const { annotations } of await fileAnnotations(pdf)) {
    for (const ann of annotations) names.push(ann.file?.filename ?? ann.fileId);
  }
  return names;
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

  for (const [i, { page, annotations }] of (await fileAnnotations(pdf)).entries()) {
    const n = i + 1;
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

// Bound on the cached canvases' total area. Slides render at their exact
// display size, so a drag-resize or a move between monitors leaves a trail of
// full-screen canvases (a 4K slide is ~8 Mpx, 32 MB) that would otherwise
// never be freed. Least recently used goes first; Map order is the recency.
const PAGE_CACHE_MAX_PIXELS = 96_000_000;
let pageCachePixels = 0;

function cachePut(key: string, canvas: HTMLCanvasElement) {
  pageCache.set(key, canvas);
  pageCachePixels += canvas.width * canvas.height;
  for (const [oldest, old] of pageCache) {
    if (pageCachePixels <= PAGE_CACHE_MAX_PIXELS || oldest === key) break;
    pageCache.delete(oldest);
    pageCachePixels -= old.width * old.height;
    // Release the backing store now rather than whenever GC gets to it.
    old.width = old.height = 0;
  }
}

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

/** iOS/iPadOS, where every browser is WebKit. iPadOS reports as a Mac but has touch points. */
const isIOS =
  typeof navigator !== "undefined" &&
  (/iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

export async function loadPdf(url: string): Promise<PDFDocumentProxy> {
  // Elsewhere, let pdf.js range-load: it reads the cross-reference table and
  // just the objects the first slide needs, so a large deck paints long before
  // the whole file has arrived (the rest keeps streaming in behind it). A
  // server that doesn't advertise byte ranges simply gets one full GET.
  //
  // On iOS fetch the whole file in one request instead: WebKit there
  // mishandles cross-origin 206 Partial Content responses, so range-loaded
  // PDFs that work on desktop fail on iOS.
  return openPdf(isIOS ? { url, disableRange: true, disableStream: true } : { url });
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
  // With targetWidth: the height of the box the page is shown in, device
  // pixels. The page is fitted inside both, the way object-fit: contain shows
  // it, so a letterboxed slide's canvas is drawn 1:1 instead of shrunk.
  targetHeight?: number;
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
    pageCachePixels = 0;
    pageCachePdf = pdf;
  }

  const page = await pdf.getPage(pageNum);
  const base = page.getViewport({ scale: 1 });

  let scale: number;
  if (options.targetWidth) {
    // Exactly the displayed size, not rounded up to a coarser step: any
    // overshoot gets resampled down on screen, and that resampling is what
    // blurs text. Resize churn is held off by the callers' own thresholds.
    const width = Math.min(options.targetWidth, MAX_CANVAS_WIDTH);
    scale = width / base.width;
    if (options.targetHeight) scale = Math.min(scale, options.targetHeight / base.height);
  } else {
    scale = options.scale ?? 2;
  }
  scale = Math.max(0.25, scale);

  const key = `${pageNum}-${scale}`;
  const cached = pageCache.get(key);
  if (cached) {
    // Most recently used again.
    pageCache.delete(key);
    pageCache.set(key, cached);
    return copyCanvas(cached);
  }

  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);

  await page.render({
    canvasContext: canvas.getContext("2d")!,
    canvas,
    viewport,
  }).promise;
  firstPaint(pdf).resolve();

  cachePut(key, canvas);
  return copyCanvas(canvas);
}

export function clearCache() {
  pageCache.clear();
  pageCachePixels = 0;
  pageCachePdf = null;
}

/**
 * Renders a page and shows it in `container`, fitted the way object-fit:
 * contain shows it. Renders resolve out of order (cache hits are near-instant,
 * fresh ones aren't), so call the returned function when the result is no
 * longer wanted — a late one is then dropped instead of covering a newer page.
 * With `ifEmpty`, a container that already shows something is left alone.
 * A page that fails to render leaves the container as it was.
 */
export function renderPageInto(
  container: HTMLElement,
  pdf: PDFDocumentProxy,
  pageNum: number,
  opts: RenderOptions,
  { ifEmpty = false, onPainted }: { ifEmpty?: boolean; onPainted?: () => void } = {},
): () => void {
  let stale = false;
  renderPage(pdf, pageNum, opts)
    .then((canvas) => {
      if (stale || (ifEmpty && container.childElementCount > 0)) return;
      container.innerHTML = "";
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.objectFit = "contain";
      container.appendChild(canvas);
      onPainted?.();
    })
    .catch((err) => {
      // A destroyed document (the deck was just swapped) rejects every render
      // still in flight; nothing to show for those.
      if (!stale) console.warn(`Couldn't render page ${pageNum}:`, err);
    });
  return () => {
    stale = true;
  };
}
