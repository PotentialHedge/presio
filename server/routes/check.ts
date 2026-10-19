// POST /api/check — upload a PDF, get back a structured sidecar validity report.
// Accepts multipart/form-data with a `file` field (PDF).
// Returns JSON; no auth required. Useful for CI pipelines, LLM tooling, etc.

import type express from "express";
import multer from "multer";
import { openPdf, closePdf, readAttachments } from "../lib/pdfDoc.js";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { canonicalBaseUrl } from "../lib/baseUrl.js";
import { MAX_PDF_BYTES } from "../validation.js";
import { unusualAttachmentWarning } from "../../shared/attachments.js";
import {
  binaryIssues,
  checkMediaJson,
  checkNotes,
  MEDIA_BINARY_RE,
  MEDIA_JSON_RE,
  NOTES_RE,
  referencedBinaries,
  type AttachmentIssue,
  type Validity,
} from "../../shared/sidecar.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PDF_BYTES } });

// ── Validation types ──────────────────────────────────────────────────────────

type Issue = AttachmentIssue;

interface AttachmentResult {
  filename: string;
  kind: "notes" | "media-json" | "media-binary" | "unknown";
  slide?: number;
  validity: Validity;
  issues: Issue[];
  /** Rendered notes text (notes attachments only). */
  text?: string;
  /** Parsed JSON (notes and media-json). */
  data?: unknown;
}

interface PageResult {
  page: number;
  notes: AttachmentResult | null;
  media: AttachmentResult[];
}

interface CheckReport {
  $schema: string;
  pageCount: number;
  summary: { total: number; valid: number; warning: number; invalid: number };
  pages: PageResult[];
  orphans: AttachmentResult[];
}

export type { CheckReport };

export type CheckResult =
  | { ok: true; report: CheckReport }
  | { ok: false; status: number; error: string };

/** Build a sidecar validity report from PDF bytes (shared by REST and MCP). */
export async function buildCheckReport(buffer: Buffer, schemaBaseUrl: string): Promise<CheckResult> {
  let pdf: PDFDocumentProxy;
  try {
    pdf = await openPdf({ data: new Uint8Array(buffer) });
  } catch {
    return { ok: false, status: 422, error: "Could not parse PDF" };
  }

  const pageCount = pdf.numPages;
  const entries = await readAttachments(pdf);
  await closePdf(pdf);

  if (entries.length === 0) {
    return {
      ok: true,
      report: {
        $schema: `${schemaBaseUrl}/schema/check-report.schema.json`,
        pageCount,
        summary: { total: 0, valid: 0, warning: 0, invalid: 0 },
        pages: Array.from({ length: pageCount }, (_, i) => ({ page: i + 1, notes: null, media: [] })),
        orphans: [],
      },
    };
  }

  const allFilenames = new Set(entries.map((e) => e.filename));

  const referenced = referencedBinaries(entries);

  const notesMap = new Map<number, AttachmentResult>();
  const mediaMap = new Map<number, AttachmentResult[]>();
  const orphans: AttachmentResult[] = [];

  for (const { filename, content } of entries) {
    if (NOTES_RE.test(filename)) {
      const { parsed, markdown, ...check } = checkNotes(filename, content, pageCount);
      const a: AttachmentResult = { filename, kind: "notes", ...check, text: markdown, data: parsed };
      if (a.slide !== undefined) notesMap.set(a.slide, a);
      else orphans.push(a);
    } else if (MEDIA_JSON_RE.test(filename)) {
      const { parsed, ...check } = checkMediaJson(filename, content, pageCount, allFilenames);
      const a: AttachmentResult = { filename, kind: "media-json", ...check, data: parsed };
      if (a.slide !== undefined) {
        const arr = mediaMap.get(a.slide) ?? [];
        arr.push(a);
        mediaMap.set(a.slide, arr);
      } else {
        orphans.push(a);
      }
    } else if (MEDIA_BINARY_RE.test(filename)) {
      if (!referenced.has(filename)) {
        orphans.push({ filename, kind: "media-binary", validity: "warning", issues: binaryIssues(filename, referenced) });
      }
    } else {
      // Not one of Presio's own sidecars: a plugin's file, fine when it's JSON,
      // an image or a video.
      const warning = unusualAttachmentWarning(filename);
      orphans.push({
        filename, kind: "unknown", validity: warning ? "warning" : "valid",
        issues: warning ? [{ level: "warning", message: warning }] : [],
      });
    }
  }

  const pages: PageResult[] = Array.from({ length: pageCount }, (_, i) => ({
    page: i + 1,
    notes: notesMap.get(i + 1) ?? null,
    media: mediaMap.get(i + 1) ?? [],
  }));

  const all = [...notesMap.values(), ...[...mediaMap.values()].flat(), ...orphans];
  const summary = { total: all.length, valid: 0, warning: 0, invalid: 0 };
  for (const a of all) summary[a.validity]++;

  return {
    ok: true,
    report: { $schema: `${schemaBaseUrl}/schema/check-report.schema.json`, pageCount, summary, pages, orphans },
  };
}

// ── Route ─────────────────────────────────────────────────────────────────────

export function registerCheckRoute(app: express.Express) {
  /**
   * POST /api/check
   * Body: multipart/form-data, field name "file", PDF only.
   * Returns: JSON CheckReport.
   *
   * Example:
   *   curl -s -F file=@deck.pdf https://presio.ch/api/check | jq .
   */
  app.post("/api/check", upload.single("file"), async (req, res) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'Missing "file" field (multipart/form-data)' });
      return;
    }
    if (file.mimetype !== "application/pdf" && !file.originalname.endsWith(".pdf")) {
      res.status(400).json({ error: "File must be a PDF" });
      return;
    }

    const result = await buildCheckReport(file.buffer, canonicalBaseUrl(req));
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json(result.report);
  });
}
