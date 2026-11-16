// An HTML animation's frame document: the bundle (entry page + assets, as
// JSON) and the runtime that loads it and owns its clock (html-runtime.js).
// The presio Typst package builds the same document for its HTML export.

import runtime from "./html-runtime.js?raw";

/** A file in the bundle: text as is, anything else base64. */
export interface BundleFile {
  text?: string;
  b64?: string;
  mime?: string;
}

export interface BundleOptions {
  /** Driven by Presio (postMessage) rather than playing by itself. */
  embedded?: boolean;
  autoplay?: boolean;
  loop?: boolean;
  /** Length in seconds, when the author gave one. */
  duration?: number;
  controls?: boolean;
  interactive?: boolean;
  muted?: boolean;
}

export function buildSrcdoc(entry: string, files: Record<string, BundleFile>, options: BundleOptions): string {
  // "<" only ever appears inside JSON strings, so escaping it keeps the
  // bundle from closing its <script> early.
  const json = JSON.stringify({ entry, files, options }).replace(/</g, "\\u003c");
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<script type="application/json" id="presio-bundle">${json}</script>` +
    `<script>${runtime}</script></head></html>`
  );
}
