// Reading a PDF the presenter picked or dropped, and storing it as a local
// deck. Nothing here touches the network.

import { openPdf, destroyPdf } from "@/lib/pdf";
import { sha256Hex } from "@/lib/analytics";
import { idbPut, type LocalPresentation } from "@/lib/localStore";
import { newLocalDeckId } from "@/lib/localId";

export interface ImportedPdf {
  /** An in-memory copy of the bytes (see readPdfFile). */
  blob: Blob;
  /** SHA-256 of the bytes, when this origin has crypto.subtle. */
  sha256?: string;
  /** The file's name without ".pdf". */
  filename: string;
  totalSlides: number;
}

/**
 * Reads a PDF file once: its bytes, fingerprint and page count.
 *
 * The blob is an in-memory copy rather than the File itself. A File from the
 * picker is only a reference to the file on disk, and IndexedDB persists that
 * reference — not the bytes. If the file is moved, edited, or removed before
 * the deck is synced (the login round-trip alone is enough on some browsers),
 * reading it back fails partway through the upload and the server sees a
 * truncated multipart body. The copy and the hash are both taken before
 * getDocument(), which transfers the buffer to the pdf.js worker and leaves it
 * detached. Hashing reads memory already in hand, so it adds no file I/O, and
 * only the digest ever leaves the browser.
 */
export async function readPdfFile(file: File): Promise<ImportedPdf> {
  const buf = await file.arrayBuffer();
  const blob = new Blob([buf], { type: "application/pdf" });
  let sha256: string | undefined;
  try {
    sha256 = await sha256Hex(buf);
  } catch {
    // No crypto.subtle (e.g. plain-http origins): go on without a fingerprint.
  }
  const doc = await openPdf({ data: new Uint8Array(buf) });
  const totalSlides = doc.numPages;
  destroyPdf(doc);
  return { blob, sha256, filename: file.name.replace(/\.pdf$/i, ""), totalSlides };
}

/** Why storing a deck in this browser failed, in words a presenter can act on. */
export const STORE_FAILED =
  "Couldn't store the presentation in this browser. Private/incognito mode isn't supported — please use a normal window.";

/**
 * Stores a PDF as a new local deck under an id minted here, and returns the id.
 * The join code (and the `sessions` row behind it) is created later,
 * server-side, if and when the presenter shares the deck.
 */
export async function createLocalDeck(
  pdf: ImportedPdf,
  extra: Partial<Pick<LocalPresentation, "handle">> = {},
): Promise<string> {
  const id = newLocalDeckId();
  try {
    await idbPut({
      id,
      filename: pdf.filename,
      totalSlides: pdf.totalSlides,
      blob: pdf.blob,
      sha256: pdf.sha256,
      ...(extra.handle ? { handle: extra.handle } : {}),
      createdAt: Date.now(),
    });
  } catch {
    throw new Error(STORE_FAILED);
  }
  return id;
}
