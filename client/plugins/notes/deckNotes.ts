// Where speaker notes live in a PDF, read and written from inside the plugin:
//  - `notes-slide-{n}.json` attachments, the sidecar the presio Typst package
//    emits (and what edits here write): { "notes": markdown | Typst AST | [...] };
//  - otherwise, link annotations whose URL is `note:<url-encoded text>`.
// The sidecar format itself is shared with the checker (src/lib), which
// validates and edits the same files.

import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from "pdf-lib";
import { notesToMarkdown } from "../../../shared/typstNotes.ts";
import { setSlideNotes } from "../../src/lib/notesAttach";

/** Markdown per slide; no entry = no notes. */
export type Notes = Map<number, string>;

const SIDECAR_RE = /^notes-slide-(\d+)\.json$/;
const NOTE_PREFIX = "note:";

function annotationNotes(doc: PDFDocument): Notes {
  const out: Notes = new Map();
  doc.getPages().forEach((page, i) => {
    const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annots) return;
    const texts: string[] = [];
    for (let j = 0; j < annots.size(); j++) {
      const action = annots.lookupMaybe(j, PDFDict)?.lookupMaybe(PDFName.of("A"), PDFDict);
      const uri = action?.lookup(PDFName.of("URI"));
      const url = uri instanceof PDFString || uri instanceof PDFHexString ? uri.decodeText() : "";
      if (!url.startsWith(NOTE_PREFIX)) continue;
      try {
        texts.push(decodeURIComponent(url.slice(NOTE_PREFIX.length)));
      } catch { /* malformed escape: skip it */ }
    }
    if (texts.length) out.set(i + 1, texts.join("\n\n"));
  });
  return out;
}

/** Every slide's notes in the deck on screen. A slide's sidecar wins over
 *  its annotations. */
export async function readNotes(): Promise<Notes> {
  const [attachments, bytes] = await Promise.all([presio.deck.attachments(), presio.deck.bytes()]);
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  const notes = annotationNotes(doc);
  for (const { filename, bytes: content } of attachments) {
    const match = SIDECAR_RE.exec(filename);
    if (!match) continue;
    try {
      const data = JSON.parse(new TextDecoder().decode(content));
      notes.set(parseInt(match[1], 10), notesToMarkdown(data.notes));
    } catch { /* skip malformed */ }
  }
  for (const [slide, text] of notes) if (!text) notes.delete(slide);
  return notes;
}

/** Save one slide's notes into the deck ("" removes them). */
export async function writeNotes(slide: number, text: string): Promise<void> {
  const updated = await setSlideNotes(await presio.deck.bytes(), slide, text);
  await presio.deck.save(updated);
}
