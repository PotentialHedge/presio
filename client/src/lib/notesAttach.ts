// Write speaker notes into a PDF as a `notes-slide-{n}.json` embedded-file
// attachment — the same sidecar format the presio Typst package emits, so the
// notes read back through `extractSpeakerNotes` (see pdf.ts).

import { PDFDocument } from "pdf-lib";
import { dropAttachments } from "./removeAttachments";

export async function setSlideNotes(
  pdfBytes: Uint8Array,
  slide: number,
  notes: string
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(pdfBytes);
  const filename = `notes-slide-${slide}.json`;
  // Replace the slide's notes rather than pile up duplicates, wherever they
  // were attached (the document, or a page).
  dropAttachments(doc, [filename]);

  const trimmed = notes.trim();
  if (trimmed) {
    const json = new TextEncoder().encode(JSON.stringify({ notes: trimmed }));
    await doc.attach(json, filename, { mimeType: "application/json" });
  }

  return doc.save();
}
