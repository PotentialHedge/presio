// One bundle for everything about the loaded presentation: the pdf.js document
// plus what we extract from it (links, whether it carries attachments). Views
// and cards take this single object instead of a fistful of loose
// pdf/url/filename props.

import type { PDFDocumentProxy } from "pdfjs-dist";
import { hasAttachments } from "./pdf";
import { loadLinks, type PdfLink } from "./pdfLinks";
import { loadSections } from "./sections";

/** Everything derived from the PDF itself — stable until the file changes
 *  (e.g. when a plugin saves an edited deck). */
export interface Deck {
  pdf: PDFDocumentProxy;
  /** Source of the PDF bytes: server URL, or an object URL for local sessions. */
  url: string;
  filename: string;
  totalSlides: number;
  /** True when the PDF carries embedded-file attachments (presio sidecars). */
  hasAttachments: boolean;
  /** Link annotations per slide (no entry = no links). */
  linksBySlide: Map<number, PdfLink[]>;
  /** Slides where the outline's sections start, ascending (lib/sections.ts). */
  sections: number[];
}

/** The parts of a Deck read from page annotations and the outline, which a
 *  long document takes a moment to scan. */
export type DeckExtras = Pick<Deck, "hasAttachments" | "linksBySlide" | "sections">;

/** What a deck shows until its extras are read: no links, no attachments,
 *  no sections. */
export const NO_EXTRAS: DeckExtras = { hasAttachments: false, linksBySlide: new Map(), sections: [] };

/** A deck for a freshly loaded PDF. Synchronous, so the first slide never
 *  waits on the annotation scan — the extras follow from loadDeckExtras. */
export function makeDeck(
  pdf: PDFDocumentProxy,
  url: string,
  filename: string,
  extras: DeckExtras = NO_EXTRAS
): Deck {
  return { pdf, url, filename, totalSlides: pdf.numPages, ...extras };
}

/** Read a deck's links, sections and whether it carries attachments. Never
 *  rejects — all are best-effort extras. */
export async function loadDeckExtras(pdf: PDFDocumentProxy): Promise<DeckExtras> {
  const [attachments, linksBySlide, sections] = await Promise.all([
    hasAttachments(pdf).catch(() => false),
    loadLinks(pdf).catch(() => new Map<number, PdfLink[]>()),
    loadSections(pdf).catch(() => []),
  ]);
  return { hasAttachments: attachments, linksBySlide, sections };
}
