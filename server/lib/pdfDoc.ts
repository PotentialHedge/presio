// Owns the two pdf.js API shapes that changed in v6, so the rest of the server
// keeps talking about documents rather than about loading tasks and Maps.
//
// v6 moved `destroy()` off PDFDocumentProxy and onto the loading task, and
// changed `getAttachments()` to return a Map whose entries no longer carry
// their bytes eagerly. Both changes are quiet: `Object.keys()` on a Map is
// `[]`, so the old call sites reported a deck with notes as a deck with none,
// and the `as Record<...>` casts they used hid it from the compiler.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { isValidTotalSlides, MAX_TOTAL_SLIDES } from "../validation.js";

type DocumentSource = Parameters<typeof getDocument>[0];

/**
 * The loading task that owns each open document.
 *
 * Weak so a document that is dropped without being closed doesn't pin its task
 * here for the life of the process.
 */
const tasks = new WeakMap<PDFDocumentProxy, ReturnType<typeof getDocument>>();

/** Open a PDF. Pair with closePdf() to release the worker. */
export async function openPdf(source: DocumentSource): Promise<PDFDocumentProxy> {
  const task = getDocument(source);
  const doc = await task.promise;
  tasks.set(doc, task);
  return doc;
}

/**
 * Release a document's worker.
 *
 * Destroying the task is what v5's `doc.destroy()` did internally, so this is
 * the same operation reached through the handle the caller already holds.
 */
export async function closePdf(doc: PDFDocumentProxy | null | undefined): Promise<void> {
  if (!doc) return;
  await tasks.get(doc)?.destroy();
}

/** One of a deck's sidecar attachments, with its bytes resolved. */
export interface PdfAttachment {
  filename: string;
  content: Uint8Array;
  /** For a file attached to a page (a FileAttachment annotation) rather than
   *  to the document: its 1-based page. */
  page?: number;
}

/**
 * Read a deck's attachments, bytes included: the document's own, then each
 * page's in page order.
 *
 * In v6 an entry's `content` is only populated when it happens to be loaded
 * already; otherwise the bytes are fetched on demand. Entries whose content
 * cannot be resolved are dropped rather than surfaced as empty, so callers
 * never mistake a failed read for an empty file.
 */
export async function readAttachments(doc: PDFDocumentProxy): Promise<PdfAttachment[]> {
  const out: PdfAttachment[] = [];
  const raw = await doc.getAttachments();
  for (const [id, entry] of raw ?? []) {
    const content = entry.content ?? (await doc.getAttachmentContent(id));
    if (content) out.push({ filename: entry.filename ?? id, content });
  }

  for (let n = 1; n <= doc.numPages; n++) {
    const annotations = await (await doc.getPage(n)).getAnnotations();
    for (const ann of annotations) {
      if (ann.subtype !== "FileAttachment" || !ann.fileId) continue;
      const content = await doc.getAttachmentContent(ann.fileId);
      if (content) out.push({ filename: ann.file?.filename ?? ann.fileId, content, page: n });
    }
  }
  return out;
}

/**
 * An uploaded deck's page count, checked against MAX_TOTAL_SLIDES: the count,
 * or why the upload is refused.
 */
export async function countDeckPages(
  buffer: Buffer,
): Promise<{ ok: true; totalSlides: number } | { ok: false; status: number; error: string }> {
  let totalSlides: number;
  try {
    const doc = await openPdf({ data: new Uint8Array(buffer) });
    totalSlides = doc.numPages;
    void closePdf(doc);
  } catch {
    return { ok: false, status: 422, error: "The file could not be read as a PDF" };
  }
  if (!isValidTotalSlides(totalSlides)) {
    return { ok: false, status: 400, error: `PDF exceeds the ${MAX_TOTAL_SLIDES}-page limit` };
  }
  return { ok: true, totalSlides };
}
