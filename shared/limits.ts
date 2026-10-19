// Caps both sides enforce. The client checks them first so a plugin or a
// person hears "too big" at once; the server checks them again because it
// can't trust the client. Measure with jsonBytes() on both sides, so the two
// always agree on what fits.

/** Largest PDF the server accepts on an upload (sync, claim, re-upload, /api/check). */
export const MAX_PDF_BYTES = 50 * 1024 * 1024;

/**
 * What one plugin may keep retained: this many message types, this many bytes
 * of payload (as JSON). A drawing keeps its strokes this way, a slide's worth
 * per message; 2 MB is several hundred thousand compactly encoded points.
 */
export const MAX_RETAINED_PER_PLUGIN = 1024;
export const MAX_RETAINED_BYTES_PER_PLUGIN = 2 * 1024 * 1024;

/** One presio.history op, as JSON: the size of a plugin message. */
export const MAX_HISTORY_OP_BYTES = 16 * 1024;
/** One presio.blobs blob. */
export const MAX_BLOB_BYTES = 5 * 1024 * 1024;

const encoder = new TextEncoder();

/**
 * A value's size once serialized, in UTF-8 bytes (what the wire carries), or
 * Infinity when it can't be serialized (a cycle, a BigInt). `undefined`
 * serializes to nothing: 0.
 */
export function jsonBytes(value: unknown): number {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return Infinity;
  }
  return json === undefined ? 0 : encoder.encode(json).length;
}
