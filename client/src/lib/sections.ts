// A deck's sections, from its PDF outline (bookmarks): the slides where the
// outline's top-level entries start. That's how Typst (touying's `=`
// headings), LaTeX/beamer (\section) and most slide tools write sections.
// ⌥← / ⌥→ jump between them.

import type { PDFDocumentProxy } from "pdfjs-dist";

type OutlineItem = Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>[number];

/** The slide (1-based) an outline entry points to, or null. */
async function slideOf(pdf: PDFDocumentProxy, dest: OutlineItem["dest"]): Promise<number | null> {
  try {
    const explicit = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
    const target = explicit?.[0];
    if (typeof target === "number") return target + 1;
    if (target && typeof target === "object") return (await pdf.getPageIndex(target)) + 1;
  } catch {
    // A broken destination is just not a section.
  }
  return null;
}

/** The slides where sections start, ascending; empty without an outline. */
export async function loadSections(pdf: PDFDocumentProxy): Promise<number[]> {
  const entries = (await pdf.getOutline()) ?? [];
  const slides = await Promise.all(entries.map((item) => slideOf(pdf, item.dest)));
  return [...new Set(slides.filter((s): s is number => s !== null))].sort((a, b) => a - b);
}

/** Where the next section starts after `slide`, or null in the last one. */
export function nextSectionStart(sections: readonly number[], slide: number): number | null {
  return sections.find((s) => s > slide) ?? null;
}

/** Where ⌥← goes from `slide`: the start of its own section, or from there,
 *  the one before. Null before the first section. */
export function prevSectionStart(sections: readonly number[], slide: number): number | null {
  return sections.findLast((s) => s < slide) ?? null;
}
