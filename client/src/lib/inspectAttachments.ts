// Strict sidecar inspection for the PDF checker tool.
// Unlike the notes and media plugins' readers (which silently skip bad
// attachments for the presenter), this reports every issue so the user can
// fix their Typst source.

import type { PDFDocumentProxy } from "pdfjs-dist";
import { readAttachments } from "./pdf";
import { notesToMarkdown } from "./typstNotes";
import { unusualAttachmentWarning } from "@shared/attachments";

export type Validity = "valid" | "warning" | "invalid";

export interface AttachmentIssue {
  level: "error" | "warning";
  message: string;
}

export interface InspectedAttachment {
  filename: string;
  kind: "notes" | "media-json" | "media-binary" | "unknown";
  slide?: number;
  validity: Validity;
  issues: AttachmentIssue[];
  content: Uint8Array;
  parsed?: unknown;
  previewText?: string;
}

export interface PageReport {
  page: number;
  notes: InspectedAttachment | null;
  media: InspectedAttachment[];
}

export interface DeckReport {
  pageCount: number;
  pages: PageReport[];
  orphans: InspectedAttachment[];
  /** All binary media attachments keyed by filename, for open/download. */
  binaries: Map<string, InspectedAttachment>;
  summary: { valid: number; warning: number; invalid: number; total: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validity(issues: AttachmentIssue[]): Validity {
  if (issues.some((i) => i.level === "error")) return "invalid";
  if (issues.some((i) => i.level === "warning")) return "warning";
  return "valid";
}

function inspectNotesJson(
  filename: string,
  content: Uint8Array,
  pageCount: number
): InspectedAttachment {
  const issues: AttachmentIssue[] = [];
  const match = filename.match(/^notes-slide-(\d+)\.json$/);
  const slideFromName = match ? parseInt(match[1], 10) : NaN;

  if (!match) {
    issues.push({ level: "error", message: "Filename does not match notes-slide-{N}.json" });
  } else if (slideFromName < 1 || slideFromName > pageCount) {
    issues.push({ level: "error", message: `Slide ${slideFromName} is out of range (1–${pageCount})` });
  }

  let parsed: unknown;
  let previewText: string | undefined = undefined;

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    issues.push({ level: "error", message: "Content is not valid UTF-8" });
    return { filename, kind: "notes", slide: slideFromName || undefined, validity: "invalid", issues, content };
  }

  try {
    parsed = JSON.parse(text);
  } catch {
    issues.push({ level: "error", message: "Not valid JSON" });
    return { filename, kind: "notes", slide: slideFromName || undefined, validity: "invalid", issues, content };
  }

  if (!isRecord(parsed)) {
    issues.push({ level: "error", message: "Must be a JSON object" });
    return { filename, kind: "notes", slide: slideFromName || undefined, validity: "invalid", issues, content, parsed };
  }
  const data = parsed;

  if (!("notes" in data)) {
    issues.push({ level: "error", message: 'Missing required "notes" field' });
  } else {
    const notes = data.notes;
    if (typeof notes !== "string" && !Array.isArray(notes) && (typeof notes !== "object" || notes === null)) {
      issues.push({ level: "error", message: '"notes" must be a string, array, or Typst AST object' });
    } else {
      // Check slide field disagreement
      if ("slide" in data && data.slide !== undefined) {
        const slideFromField = parseInt(String(data.slide), 10);
        if (!isNaN(slideFromField) && !isNaN(slideFromName) && slideFromField !== slideFromName) {
          issues.push({
            level: "warning",
            message: `"slide" field (${slideFromField}) disagrees with filename (${slideFromName})`,
          });
        }
      }

      try {
        previewText = notesToMarkdown(notes);
      } catch {
        issues.push({ level: "warning", message: "Could not render notes preview (AST may be non-standard)" });
      }
    }
  }

  return {
    filename,
    kind: "notes",
    slide: isNaN(slideFromName) ? undefined : slideFromName,
    validity: validity(issues),
    issues,
    content,
    parsed,
    previewText,
  };
}

function inspectMediaJson(
  filename: string,
  content: Uint8Array,
  pageCount: number,
  attachmentNames: Set<string>
): InspectedAttachment {
  const issues: AttachmentIssue[] = [];
  const match = filename.match(/^media-slide-(\d+)-(.+)\.json$/);
  const slideFromName = match ? parseInt(match[1], 10) : NaN;

  if (!match) {
    issues.push({ level: "error", message: "Filename does not match media-slide-{N}-{id}.json" });
  } else if (slideFromName < 1 || slideFromName > pageCount) {
    issues.push({ level: "error", message: `Slide ${slideFromName} is out of range (1–${pageCount})` });
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    issues.push({ level: "error", message: "Content is not valid UTF-8" });
    return { filename, kind: "media-json", slide: slideFromName || undefined, validity: "invalid", issues, content };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    issues.push({ level: "error", message: "Not valid JSON" });
    return { filename, kind: "media-json", slide: slideFromName || undefined, validity: "invalid", issues, content };
  }

  if (!isRecord(parsed)) {
    issues.push({ level: "error", message: "Must be a JSON object" });
    return { filename, kind: "media-json", slide: slideFromName || undefined, validity: "invalid", issues, content, parsed };
  }
  const m = parsed;

  // Required fields
  for (const field of ["id", "mime", "slide"] as const) {
    if (!(field in m) || m[field] === undefined) {
      issues.push({ level: "error", message: `Missing required field "${field}"` });
    }
  }

  const numericFields = ["x_pt", "y_pt", "w_pt", "h_pt"] as const;
  for (const field of numericFields) {
    if (typeof m[field] !== "number") {
      issues.push({ level: "error", message: `"${field}" must be a number` });
    }
  }
  if (typeof m.w_pt === "number" && m.w_pt <= 0) {
    issues.push({ level: "error", message: '"w_pt" must be > 0' });
  }
  if (typeof m.h_pt === "number" && m.h_pt <= 0) {
    issues.push({ level: "error", message: '"h_pt" must be > 0' });
  }

  const validKinds = new Set(["file", "url", "youtube", "vimeo"]);
  const inferredKind = m.kind ?? (m.url ? "url" : "file");
  if (m.kind !== undefined && !validKinds.has(m.kind as string)) {
    issues.push({ level: "error", message: `"kind" must be one of: file, url, youtube, vimeo` });
  } else if (!m.kind) {
    issues.push({ level: "warning", message: `"kind" not set; inferred as "${inferredKind}"` });
  }

  const effectiveKind = validKinds.has(m.kind as string) ? (m.kind as string) : inferredKind;

  if (effectiveKind === "file") {
    if (!m.filename) {
      issues.push({ level: "error", message: '"filename" is required for kind "file"' });
    } else if (!attachmentNames.has(m.filename as string)) {
      issues.push({
        level: "error",
        message: `Binary attachment "${m.filename}" not found in PDF`,
      });
    } else if (!/^media-.+\.(gif|mp4|webm)$/i.test(m.filename as string)) {
      issues.push({
        level: "warning",
        message: `"filename" "${m.filename}" does not match expected media-{id}.{gif|mp4|webm} pattern`,
      });
    }
  } else {
    if (!m.url) {
      issues.push({ level: "error", message: `"url" is required for kind "${effectiveKind}"` });
    }
    if ((effectiveKind === "youtube" || effectiveKind === "vimeo") && !m.video_id) {
      issues.push({ level: "warning", message: '"video_id" missing — embed may not work' });
    }
  }

  return {
    filename,
    kind: "media-json",
    slide: isNaN(slideFromName) ? undefined : slideFromName,
    validity: validity(issues),
    issues,
    content,
    parsed,
  };
}

function inspectBinary(
  filename: string,
  content: Uint8Array,
  referencedBinaries: Set<string>
): InspectedAttachment {
  const issues: AttachmentIssue[] = [];
  const isRecognized = /^media-.+\.(gif|mp4|webm)$/i.test(filename);

  if (!isRecognized) {
    issues.push({ level: "warning", message: "Filename does not match the media-{id}.{gif|mp4|webm} pattern" });
  }

  if (!referencedBinaries.has(filename)) {
    issues.push({ level: "warning", message: "No media JSON attachment references this file" });
  }

  return {
    filename,
    kind: "media-binary",
    validity: validity(issues),
    issues,
    content,
  };
}

export async function inspectAttachments(pdf: PDFDocumentProxy): Promise<DeckReport> {
  const pageCount = pdf.numPages;
  const entries = await readAttachments(pdf);

  if (entries.length === 0) {
    const pages: PageReport[] = Array.from({ length: pageCount }, (_, i) => ({
      page: i + 1,
      notes: null,
      media: [],
    }));
    return { pageCount, pages, orphans: [], binaries: new Map(), summary: { valid: 0, warning: 0, invalid: 0, total: 0 } };
  }

  const allNames = new Set(entries.map((e) => e.filename));

  // First pass: collect media JSON to know which binaries are referenced
  const referencedBinaries = new Set<string>();
  for (const { filename, content } of entries) {
    if (/^media-slide-\d+-.+\.json$/.test(filename)) {
      try {
        const m = JSON.parse(new TextDecoder().decode(content)) as Record<string, unknown>;
        if (m.filename) referencedBinaries.add(m.filename as string);
      } catch { /* handled in inspect */ }
    }
  }

  // Second pass: classify and inspect
  const notesMap = new Map<number, InspectedAttachment>();
  const mediaMap = new Map<number, InspectedAttachment[]>();
  const binaries = new Map<string, InspectedAttachment>();
  const orphans: InspectedAttachment[] = [];

  for (const { filename, content } of entries) {
    if (/^notes-slide-\d+\.json$/.test(filename)) {
      const a = inspectNotesJson(filename, content, pageCount);
      if (a.slide !== undefined) {
        notesMap.set(a.slide, a);
      } else {
        orphans.push(a);
      }
    } else if (/^media-slide-\d+-.+\.json$/.test(filename)) {
      const a = inspectMediaJson(filename, content, pageCount, allNames);
      const slide = a.slide;
      if (slide !== undefined) {
        const arr = mediaMap.get(slide) ?? [];
        arr.push(a);
        mediaMap.set(slide, arr);
      } else {
        orphans.push(a);
      }
    } else if (/^media-.+\.(gif|mp4|webm)$/i.test(filename)) {
      const a = inspectBinary(filename, content, referencedBinaries);
      binaries.set(filename, a);
      if (!referencedBinaries.has(filename)) {
        orphans.push(a);
      }
    } else {
      // Not one of Presio's own sidecars: a plugin's file, fine when it's JSON,
      // an image or a video.
      const warning = unusualAttachmentWarning(filename);
      const issues: AttachmentIssue[] = warning ? [{ level: "warning", message: warning }] : [];
      orphans.push({ filename, kind: "unknown", validity: validity(issues), issues, content });
    }
  }

  const pages: PageReport[] = Array.from({ length: pageCount }, (_, i) => ({
    page: i + 1,
    notes: notesMap.get(i + 1) ?? null,
    media: mediaMap.get(i + 1) ?? [],
  }));

  // Build summary across all attachments (binaries counted only when orphaned)
  const all = [
    ...notesMap.values(),
    ...[...mediaMap.values()].flat(),
    ...orphans,
  ];
  const summary = { valid: 0, warning: 0, invalid: 0, total: all.length };
  for (const a of all) summary[a.validity]++;

  return { pageCount, pages, orphans, binaries, summary };
}
