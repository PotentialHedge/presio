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

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_PDF_BYTES } });

// ── Typst AST → plain text (inlined from client/src/lib/typstNotes.ts) ────────

type AstNode = { func?: string; [k: string]: unknown };

function walkAst(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(walkAst).join("");
  if (typeof node !== "object") return "";
  const n = node as AstNode;
  const body = (n.body ?? n.child) as unknown;
  const children = n.children as unknown[] | undefined;
  switch (n.func) {
    case "text":    return typeof n.text === "string" ? n.text : "";
    case "space":   return " ";
    case "linebreak": return "\n";
    case "parbreak": return "\n\n";
    case "sequence": return (children ?? []).map(walkAst).join("");
    case "strong":  return `**${walkAst(body)}**`;
    case "emph":    return `*${walkAst(body)}*`;
    case "link": {
      const dest = typeof n.dest === "string" ? n.dest : "";
      const label = walkAst(body);
      return dest ? `[${label || dest}](${dest})` : label;
    }
    case "heading": {
      const level = typeof n.level === "number" ? Math.max(1, Math.min(6, n.level)) : 1;
      return `${"#".repeat(level)} ${walkAst(body)}`;
    }
    case "raw": {
      const text = typeof n.text === "string" ? n.text : "";
      return n.block ? `\`\`\`\n${text}\n\`\`\`` : `\`${text}\``;
    }
    case "list.item":  return `- ${walkAst(body)}`;
    case "enum.item":  return `1. ${walkAst(body)}`;
    case "list":
    case "enum": return (children ?? []).map(walkAst).join("\n");
    default:
      if (children) return children.map(walkAst).join("");
      if (body !== undefined) return walkAst(body);
      return "";
  }
}

function astToText(node: unknown): string {
  return walkAst(node).replace(/\n{3,}/g, "\n\n").trim();
}

// ── Validation types ──────────────────────────────────────────────────────────

type Validity = "valid" | "warning" | "invalid";

interface Issue { level: "error" | "warning"; message: string }

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

  const referencedBinaries = new Set<string>();
  for (const { filename, content } of entries) {
    if (/^media-slide-\d+-.+\.json$/.test(filename)) {
      try {
        const m = JSON.parse(new TextDecoder().decode(content)) as Record<string, unknown>;
        if (m.filename) referencedBinaries.add(m.filename as string);
      } catch { /* handled below */ }
    }
  }

  const notesMap = new Map<number, AttachmentResult>();
  const mediaMap = new Map<number, AttachmentResult[]>();
  const orphans: AttachmentResult[] = [];

  for (const { filename, content } of entries) {
    if (/^notes-slide-\d+\.json$/.test(filename)) {
      const a = validateNotes(filename, content, pageCount);
      if (a.slide !== undefined) notesMap.set(a.slide, a);
      else orphans.push(a);
    } else if (/^media-slide-\d+-.+\.json$/.test(filename)) {
      const a = validateMediaJson(filename, content, pageCount, allFilenames);
      if (a.slide !== undefined) {
        const arr = mediaMap.get(a.slide) ?? [];
        arr.push(a);
        mediaMap.set(a.slide, arr);
      } else {
        orphans.push(a);
      }
    } else if (/^media-.+\.(gif|mp4|webm)$/i.test(filename)) {
      if (!referencedBinaries.has(filename)) {
        orphans.push({
          filename, kind: "media-binary", validity: "warning",
          issues: [{ level: "warning", message: "No media JSON references this binary" }],
        });
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

function validateNotes(
  filename: string,
  content: Uint8Array,
  pageCount: number
): AttachmentResult {
  const issues: Issue[] = [];
  const match = filename.match(/^notes-slide-(\d+)\.json$/);
  const slide = match ? parseInt(match[1], 10) : NaN;

  if (!match) {
    issues.push({ level: "error", message: "Filename does not match notes-slide-{N}.json" });
  } else if (slide < 1 || slide > pageCount) {
    issues.push({ level: "error", message: `Slide ${slide} is out of range (1–${pageCount})` });
  }

  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(content); }
  catch { return { filename, kind: "notes", slide: slide || undefined, validity: "invalid", issues: [...issues, { level: "error", message: "Content is not valid UTF-8" }] }; }

  let data: unknown;
  try { data = JSON.parse(text); }
  catch { return { filename, kind: "notes", slide: slide || undefined, validity: "invalid", issues: [...issues, { level: "error", message: "Not valid JSON" }] }; }

  if (!isRecord(data)) {
    return { filename, kind: "notes", slide: slide || undefined, validity: "invalid", issues: [...issues, { level: "error", message: "Must be a JSON object" }], data };
  }
  const d = data;
  let rendered: string | undefined;

  if (!("notes" in d)) {
    issues.push({ level: "error", message: 'Missing "notes" field' });
  } else {
    const n = d.notes;
    if (typeof n !== "string" && !Array.isArray(n) && (typeof n !== "object" || n === null)) {
      issues.push({ level: "error", message: '"notes" must be a string, array, or AST object' });
    } else {
      if ("slide" in d) {
        const sf = parseInt(String(d.slide), 10);
        if (!isNaN(sf) && !isNaN(slide) && sf !== slide) {
          issues.push({ level: "warning", message: `"slide" field (${sf}) disagrees with filename (${slide})` });
        }
      }
      try {
        rendered = typeof n === "string" ? n
          : Array.isArray(n) ? n.map(astToText).filter(Boolean).join("\n\n---\n\n")
          : astToText(n);
      } catch {
        issues.push({ level: "warning", message: "Could not render notes text" });
      }
    }
  }

  return { filename, kind: "notes", slide: isNaN(slide) ? undefined : slide, validity: issueValidity(issues), issues, text: rendered, data };
}

function validateMediaJson(
  filename: string,
  content: Uint8Array,
  pageCount: number,
  allFilenames: Set<string>
): AttachmentResult {
  const issues: Issue[] = [];
  const match = filename.match(/^media-slide-(\d+)-(.+)\.json$/);
  const slide = match ? parseInt(match[1], 10) : NaN;

  if (!match) {
    issues.push({ level: "error", message: "Filename does not match media-slide-{N}-{id}.json" });
  } else if (slide < 1 || slide > pageCount) {
    issues.push({ level: "error", message: `Slide ${slide} is out of range (1–${pageCount})` });
  }

  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(content); }
  catch { return { filename, kind: "media-json", slide: slide || undefined, validity: "invalid", issues: [...issues, { level: "error", message: "Content is not valid UTF-8" }] }; }

  let data: unknown;
  try { data = JSON.parse(text); }
  catch { return { filename, kind: "media-json", slide: slide || undefined, validity: "invalid", issues: [...issues, { level: "error", message: "Not valid JSON" }] }; }

  if (!isRecord(data)) {
    return { filename, kind: "media-json", slide: slide || undefined, validity: "invalid", issues: [...issues, { level: "error", message: "Must be a JSON object" }], data };
  }
  const m = data;
  for (const f of ["id", "mime", "slide"] as const) {
    if (m[f] === undefined) issues.push({ level: "error", message: `Missing field "${f}"` });
  }
  for (const f of ["x_pt", "y_pt", "w_pt", "h_pt"] as const) {
    if (typeof m[f] !== "number") issues.push({ level: "error", message: `"${f}" must be a number` });
  }
  if (typeof m.w_pt === "number" && m.w_pt <= 0) issues.push({ level: "error", message: '"w_pt" must be > 0' });
  if (typeof m.h_pt === "number" && m.h_pt <= 0) issues.push({ level: "error", message: '"h_pt" must be > 0' });

  const validKinds = new Set(["file", "url", "youtube", "vimeo"]);
  const effectiveKind = validKinds.has(m.kind as string) ? m.kind as string : (m.url ? "url" : "file");
  if (m.kind !== undefined && !validKinds.has(m.kind as string)) {
    issues.push({ level: "error", message: `"kind" must be one of: file, url, youtube, vimeo` });
  } else if (!m.kind) {
    issues.push({ level: "warning", message: `"kind" not set; inferred as "${effectiveKind}"` });
  }

  if (effectiveKind === "file") {
    if (!m.filename) {
      issues.push({ level: "error", message: '"filename" required for kind "file"' });
    } else if (!allFilenames.has(m.filename as string)) {
      issues.push({ level: "error", message: `Binary "${m.filename}" not found in PDF` });
    }
  } else {
    if (!m.url) issues.push({ level: "error", message: `"url" required for kind "${effectiveKind}"` });
    if ((effectiveKind === "youtube" || effectiveKind === "vimeo") && !m.video_id) {
      issues.push({ level: "warning", message: '"video_id" missing — embed may not work' });
    }
  }

  return { filename, kind: "media-json", slide: isNaN(slide) ? undefined : slide, validity: issueValidity(issues), issues, data };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issueValidity(issues: Issue[]): Validity {
  if (issues.some((i) => i.level === "error")) return "invalid";
  if (issues.some((i) => i.level === "warning")) return "warning";
  return "valid";
}
