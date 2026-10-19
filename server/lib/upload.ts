// Multipart uploads of a deck: multer set up once for every PDF route, and the
// field readers they share.

import type express from "express";
import multer from "multer";
import { MAX_PDF_BYTES } from "../validation.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PDF_BYTES } });

/**
 * One uploaded file in `field`, with multer's failures answered.
 *
 * Multer/busboy failures are otherwise unhandled: they carry no `status`, so
 * they fall past the body-parser handler in app.ts to the terminal one, which
 * answers 500. The common case is a body that ends before its closing boundary
 * ("Unexpected end of form") — the browser aborted mid-upload, e.g. because
 * the Blob it was streaming couldn't be read — which is the uploader's
 * problem to retry, not a server fault. Answer 400 with a usable message.
 */
export function uploadField(field: string): express.RequestHandler {
  const handler = upload.single(field);
  return (req, res, next) =>
    handler(req, res, (err: unknown) => {
      if (!err) return next();
      const code = (err as { code?: string }).code;
      if (code === "LIMIT_FILE_SIZE") {
        res.status(413).json({ error: `PDF exceeds the ${MAX_PDF_BYTES / 1024 / 1024}MB limit` });
        return;
      }
      console.error(`Upload failed for ${req.method} ${req.path}:`, err);
      res.status(400).json({
        error: "The upload didn't complete. Check your connection and try again.",
      });
    });
}

/** Whether an uploaded file is a PDF, by its type or (for a lax client) its name. */
export function isPdfUpload(file: Express.Multer.File | undefined, { byName = false } = {}): file is Express.Multer.File {
  if (!file) return false;
  return file.mimetype === "application/pdf" || (byName && file.originalname.toLowerCase().endsWith(".pdf"));
}

/** A deck's title from an uploaded or supplied name: trimmed, without ".pdf". */
export function deckTitle(name: string): string {
  return name.trim().replace(/\.pdf$/i, "");
}

/**
 * Read a multipart text field that may legitimately appear at most once.
 * Multer hands a repeated field back as an array, which a bare
 * `typeof x === "string"` check silently reads as "absent" — on /api/present
 * that turned a duplicated `session_id` into a brand new presentation, burning
 * a concurrent slot and handing back a fresh link. `null` means "sent more than
 * once" so callers can reject instead of guessing which copy was meant.
 */
export function singleField(value: unknown): string | null {
  if (value === undefined) return "";
  return typeof value === "string" ? value : null;
}
