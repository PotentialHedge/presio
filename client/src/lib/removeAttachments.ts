// Remove specific embedded-file attachments from a PDF by filename: the
// document's own (its EmbeddedFiles name tree) and those attached to a page
// (FileAttachment annotations).
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFString, PDFHexString } from "pdf-lib";

function entryName(entry: unknown): string {
  if (entry instanceof PDFHexString || entry instanceof PDFString) return entry.decodeText();
  return "";
}

/** A FileAttachment annotation's file name, without its path (as pdf.js reports it). */
function annotationFilename(annot: PDFDict): string {
  const fs = annot.lookup(PDFName.of("FS"));
  const name = fs instanceof PDFDict ? entryName(fs.lookup(PDFName.of("UF"))) || entryName(fs.lookup(PDFName.of("F"))) : entryName(fs);
  return name.split(/[/\\]/).pop() ?? "";
}

/** Drop each page's FileAttachment annotations whose file name passes `drop`. */
export function dropFileAnnotations(doc: PDFDocument, drop: (filename: string) => boolean) {
  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const annot = annots.lookup(i);
      if (!(annot instanceof PDFDict) || annot.get(PDFName.of("Subtype")) !== PDFName.of("FileAttachment")) continue;
      if (drop(annotationFilename(annot))) annots.remove(i);
    }
  }
}

/** Drop the named attachments, on the document and on its pages. Only a flat
 *  EmbeddedFiles name array is searched. */
export function dropAttachments(doc: PDFDocument, filenames: readonly string[]) {
  const toRemove = new Set(filenames);
  const arr = doc.catalog
    .lookupMaybe(PDFName.of("Names"), PDFDict)
    ?.lookupMaybe(PDFName.of("EmbeddedFiles"), PDFDict)
    ?.lookupMaybe(PDFName.of("Names"), PDFArray);
  if (arr) {
    for (let i = arr.size() - 2; i >= 0; i -= 2) {
      if (toRemove.has(entryName(arr.lookup(i)))) {
        arr.remove(i + 1);
        arr.remove(i);
      }
    }
  }
  dropFileAnnotations(doc, (name) => toRemove.has(name));
}

export async function removeAttachments(pdfBytes: Uint8Array, filenames: string[]): Promise<Uint8Array> {
  if (filenames.length === 0) return pdfBytes;
  const doc = await PDFDocument.load(pdfBytes);
  dropAttachments(doc, filenames);
  return doc.save();
}
