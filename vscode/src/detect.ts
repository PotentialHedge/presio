// Whether a PDF is a Presio deck: it carries Presio's sidecars, attachments
// named as shared/sidecar.ts's NOTES_RE and MEDIA_JSON_RE say (a deck's
// videos and GIFs always come with a media-slide JSON placing them).
//
// Read from the bytes, without parsing the PDF: attachment names are PDF
// strings, either in the file as written or, from writers that pack objects
// into compressed object streams (pdf-lib, LaTeX), in one of those.

import { inflateSync } from "zlib";

// Not anchored like sidecar.ts's: a name sits inside a PDF string, maybe
// after a folder ("src/notes-slide-2.json", as Typst writes them).
const SIDECAR_NAME = /(?:^|[/(\x00])(?:notes-slide-\d+\.json|media-slide-\d+-[^()/\\\r\n]+?\.json)/;

/** Text to search: latin1, with UTF-16 strings' zero bytes dropped. */
const searchable = (bytes: Uint8Array) => Buffer.from(bytes).toString("latin1").replace(/\x00/g, "");

function* objectStreams(pdf: Buffer): Generator<Buffer> {
  let at = 0;
  for (;;) {
    const type = pdf.indexOf("/ObjStm", at, "latin1");
    if (type < 0) return;
    const start = pdf.indexOf("stream", type, "latin1");
    if (start < 0) return;
    let body = start + "stream".length;
    if (pdf[body] === 0x0d) body++;
    if (pdf[body] === 0x0a) body++;
    const end = pdf.indexOf("endstream", body, "latin1");
    if (end < 0) return;
    yield pdf.subarray(body, end);
    at = end;
  }
}

export function isPresioDeck(bytes: Uint8Array): boolean {
  if (SIDECAR_NAME.test(searchable(bytes))) return true;
  for (const stream of objectStreams(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))) {
    try {
      // Flate is what object streams use in practice; anything else is skipped.
      if (SIDECAR_NAME.test(searchable(inflateSync(stream, { finishFlush: 2 /* Z_SYNC_FLUSH */ })))) return true;
    } catch {
      // Not deflated, or cut short: nothing to find there.
    }
  }
  return false;
}
