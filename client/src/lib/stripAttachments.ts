// Produce a copy of a PDF with all embedded-file attachments removed.
// Used to offer a slimmed-down download without the presio media / notes
// JSON sidecars.

import { PDFDocument } from "pdf-lib";
import { dropFileAnnotations } from "./removeAttachments";

export async function stripAttachments(pdfBytes: Uint8Array): Promise<Uint8Array> {
  const src = await PDFDocument.load(pdfBytes);
  // Files attached to a page are annotations, which copyPages would bring
  // along: drop them first so their bytes aren't copied either.
  dropFileAnnotations(src, () => true);
  // copyPages only pulls page-reachable objects into the new doc, so any
  // embedded-files name tree on the source catalog is naturally dropped.
  const dst = await PDFDocument.create();
  const pages = await dst.copyPages(src, src.getPageIndices());
  for (const p of pages) dst.addPage(p);
  return dst.save();
}
