// Link annotations extracted from the PDF. Typst's `#link` and LaTeX's
// `\href` / `\hyperlink` produce these, and nothing in the app used them
// before: the slide is painted to a canvas, which has no notion of a clickable
// region, so links were dead on screen.
//
// Positions use the same convention as plugins' layers — a fraction of the
// page, top-left origin — so an overlay can place them over the rendered canvas.

import type { PDFDocumentProxy } from "pdfjs-dist";
import { pageAnnotations } from "./pdf";

/** A link annotation on a page. Exactly one of `url` / `slide` is set. */
export interface PdfLink {
  id: string;
  // Position/size as fraction of page (0..1), top-left origin
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
  /** External target, for http(s)/mailto links. */
  url?: string;
  /** 1-based slide an internal link jumps to. */
  slide?: number;
}

// A PDF is untrusted input (decks get handed around and downloaded), and unlike
// the media sidecars these URLs end up in an <a href> that a presenter clicks.
// An allow-list is the only safe shape here: it drops `javascript:` and friends,
// and incidentally drops presio's own `note:` annotations, which share the URL
// field but are speaker notes rather than links (the notes plugin reads them).
const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

export function safeLinkUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    return ALLOWED_PROTOCOLS.has(new URL(value).protocol) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Normalize a rectangle already converted to viewport space into page
 * fractions. pdf.js hands back the corners in either order, so this doesn't
 * assume which is which.
 */
export function linkRectPct(
  rect: number[],
  viewportW: number,
  viewportH: number
): Pick<PdfLink, "xPct" | "yPct" | "wPct" | "hPct"> | null {
  if (!viewportW || !viewportH || rect.length < 4) return null;
  const [x1, y1, x2, y2] = rect;
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const width = Math.abs(x2 - x1);
  const height = Math.abs(y2 - y1);
  if (!width || !height) return null;
  return {
    xPct: left / viewportW,
    yPct: top / viewportH,
    wPct: width / viewportW,
    hPct: height / viewportH,
  };
}

/**
 * The 1-based slide a link destination points at, or null if it can't be
 * resolved. A destination is either a named string (needing a lookup) or an
 * explicit array whose first entry identifies the page — as a page ref for a
 * real document, or already as an index in some generated files.
 *
 * A destination that doesn't resolve drops the link rather than rendering a
 * dead target.
 */
export async function resolveDestSlide(
  pdf: PDFDocumentProxy,
  dest: unknown
): Promise<number | null> {
  try {
    const resolved = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
    if (!Array.isArray(resolved) || resolved.length === 0) return null;
    const target = resolved[0];
    if (typeof target === "number") return target + 1;
    if (!target || typeof target !== "object") return null;
    return (await pdf.getPageIndex(target as never)) + 1;
  } catch {
    return null;
  }
}

const linkCache = new WeakMap<PDFDocumentProxy, Promise<Map<number, PdfLink[]>>>();

/** Every usable link annotation in the document, keyed by 1-based slide. */
export function loadLinks(pdf: PDFDocumentProxy): Promise<Map<number, PdfLink[]>> {
  let links = linkCache.get(pdf);
  if (!links) {
    links = readLinks(pdf);
    linkCache.set(pdf, links);
  }
  return links;
}

async function readLinks(pdf: PDFDocumentProxy): Promise<Map<number, PdfLink[]>> {
  const map = new Map<number, PdfLink[]>();
  for (const [index, { page, annotations }] of (await pageAnnotations(pdf)).entries()) {
    const pageNum = index + 1;
    const viewport = page.getViewport({ scale: 1 });
    const links: PdfLink[] = [];

    for (const [i, ann] of annotations.entries()) {
      if (ann.subtype !== "Link") continue;

      const url = safeLinkUrl(ann.url ?? ann.unsafeUrl);
      let slide: number | null = null;
      if (!url) {
        if (!ann.dest) continue;
        slide = await resolveDestSlide(pdf, ann.dest);
        if (!slide) continue;
      }

      // The annotation rect is in PDF user space (bottom-left origin);
      // converting both corners through the viewport flips it to the top-left
      // origin the canvas uses.
      const [rx1, ry1, rx2, ry2] = ann.rect as [number, number, number, number];
      const [x1, y1] = viewport.convertToViewportPoint(rx1, ry1);
      const [x2, y2] = viewport.convertToViewportPoint(rx2, ry2);
      const pct = linkRectPct([x1, y1, x2, y2], viewport.width, viewport.height);
      if (!pct) continue;

      links.push({
        id: `${pageNum}-${i}`,
        ...pct,
        url: url ?? undefined,
        slide: slide ?? undefined,
      });
    }

    if (links.length) map.set(pageNum, links);
  }
  return map;
}
