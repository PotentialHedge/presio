// The sidecar validators behind both checkers: the checker page
// (client/src/lib/inspectAttachments.ts) and POST /api/check
// (server/routes/check.ts). Unlike the notes and media plugins' readers, which
// skip a bad attachment quietly, these report every issue so the author can
// fix their Typst source. Each side wraps the result in its own report shape.

import { notesToMarkdown } from "./typstNotes.js";

export type Validity = "valid" | "warning" | "invalid";

export interface AttachmentIssue {
  level: "error" | "warning";
  message: string;
}

/** One sidecar, checked. `slide` is the slide its name says, when it's in the deck. */
export interface SidecarCheck {
  slide?: number;
  issues: AttachmentIssue[];
  validity: Validity;
  /** The parsed JSON, when it parsed. */
  parsed?: unknown;
}

export const NOTES_RE = /^notes-slide-(\d+)\.json$/;
export const MEDIA_JSON_RE = /^media-slide-(\d+)-(.+)\.json$/;
export const MEDIA_BINARY_RE = /^media-.+\.(gif|mp4|webm)$/i;

const MEDIA_KINDS = new Set(["file", "url", "youtube", "vimeo"]);

export function validityOf(issues: AttachmentIssue[]): Validity {
  if (issues.some((i) => i.level === "error")) return "invalid";
  if (issues.some((i) => i.level === "warning")) return "warning";
  return "valid";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The slide a sidecar's name gives, with an issue when it doesn't fit the deck. */
function slideOf(match: RegExpMatchArray | null, pattern: string, pageCount: number, issues: AttachmentIssue[]): number | undefined {
  if (!match) {
    issues.push({ level: "error", message: `Filename does not match ${pattern}` });
    return undefined;
  }
  const slide = parseInt(match[1], 10);
  if (slide < 1 || slide > pageCount) {
    issues.push({ level: "error", message: `Slide ${slide} is out of range (1–${pageCount})` });
    return undefined;
  }
  return slide;
}

/** Decodes and parses a sidecar as a JSON object, or says why it isn't one. */
function parseObject(content: Uint8Array, issues: AttachmentIssue[]): { parsed?: unknown; data?: Record<string, unknown> } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    issues.push({ level: "error", message: "Content is not valid UTF-8" });
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    issues.push({ level: "error", message: "Not valid JSON" });
    return {};
  }
  if (!isRecord(parsed)) {
    issues.push({ level: "error", message: "Must be a JSON object" });
    return { parsed };
  }
  return { parsed, data: parsed };
}

/** A notes-slide-{N}.json sidecar, plus its notes rendered as markdown. */
export function checkNotes(filename: string, content: Uint8Array, pageCount: number): SidecarCheck & { markdown?: string } {
  const issues: AttachmentIssue[] = [];
  const match = filename.match(NOTES_RE);
  const slide = slideOf(match, "notes-slide-{N}.json", pageCount, issues);
  const { parsed, data } = parseObject(content, issues);
  if (!data) return { slide, issues, validity: "invalid", parsed };

  let markdown: string | undefined;
  if (!("notes" in data)) {
    issues.push({ level: "error", message: 'Missing required "notes" field' });
  } else {
    const notes = data.notes;
    if (typeof notes !== "string" && !Array.isArray(notes) && (typeof notes !== "object" || notes === null)) {
      issues.push({ level: "error", message: '"notes" must be a string, array, or Typst AST object' });
    } else {
      if (data.slide !== undefined && match) {
        const fromField = parseInt(String(data.slide), 10);
        const fromName = parseInt(match[1], 10);
        if (!isNaN(fromField) && fromField !== fromName) {
          issues.push({ level: "warning", message: `"slide" field (${fromField}) disagrees with filename (${fromName})` });
        }
      }
      try {
        markdown = notesToMarkdown(notes);
      } catch {
        issues.push({ level: "warning", message: "Could not render notes preview (AST may be non-standard)" });
      }
    }
  }
  return { slide, issues, validity: validityOf(issues), parsed, markdown };
}

/** A media-slide-{N}-{id}.json sidecar; `names` are every attachment in the PDF. */
export function checkMediaJson(filename: string, content: Uint8Array, pageCount: number, names: Set<string>): SidecarCheck {
  const issues: AttachmentIssue[] = [];
  const slide = slideOf(filename.match(MEDIA_JSON_RE), "media-slide-{N}-{id}.json", pageCount, issues);
  const { parsed, data: m } = parseObject(content, issues);
  if (!m) return { slide, issues, validity: "invalid", parsed };

  for (const field of ["id", "mime", "slide"] as const) {
    if (m[field] === undefined) issues.push({ level: "error", message: `Missing required field "${field}"` });
  }
  for (const field of ["x_pt", "y_pt", "w_pt", "h_pt"] as const) {
    if (typeof m[field] !== "number") issues.push({ level: "error", message: `"${field}" must be a number` });
  }
  if (typeof m.w_pt === "number" && m.w_pt <= 0) issues.push({ level: "error", message: '"w_pt" must be > 0' });
  if (typeof m.h_pt === "number" && m.h_pt <= 0) issues.push({ level: "error", message: '"h_pt" must be > 0' });

  const inferred = m.url ? "url" : "file";
  if (m.kind !== undefined && !MEDIA_KINDS.has(m.kind as string)) {
    issues.push({ level: "error", message: `"kind" must be one of: file, url, youtube, vimeo` });
  } else if (!m.kind) {
    issues.push({ level: "warning", message: `"kind" not set; inferred as "${inferred}"` });
  }
  const kind = MEDIA_KINDS.has(m.kind as string) ? (m.kind as string) : inferred;

  if (kind === "file") {
    if (!m.filename) {
      issues.push({ level: "error", message: '"filename" is required for kind "file"' });
    } else if (!names.has(m.filename as string)) {
      issues.push({ level: "error", message: `Binary attachment "${m.filename}" not found in PDF` });
    } else if (!MEDIA_BINARY_RE.test(m.filename as string)) {
      issues.push({ level: "warning", message: `"filename" "${m.filename}" does not match expected media-{id}.{gif|mp4|webm} pattern` });
    }
  } else {
    if (!m.url) issues.push({ level: "error", message: `"url" is required for kind "${kind}"` });
    if ((kind === "youtube" || kind === "vimeo") && !m.video_id) {
      issues.push({ level: "warning", message: '"video_id" missing — embed may not work' });
    }
  }
  return { slide, issues, validity: validityOf(issues), parsed };
}

/** The binaries some media sidecar points at (unparseable ones are checkMediaJson's to report). */
export function referencedBinaries(entries: { filename: string; content: Uint8Array }[]): Set<string> {
  const referenced = new Set<string>();
  for (const { filename, content } of entries) {
    if (!MEDIA_JSON_RE.test(filename)) continue;
    try {
      const m = JSON.parse(new TextDecoder().decode(content)) as unknown;
      if (isRecord(m) && typeof m.filename === "string") referenced.add(m.filename);
    } catch {
      /* reported by checkMediaJson */
    }
  }
  return referenced;
}

/** A media binary's issues: only that no sidecar uses it. */
export function binaryIssues(filename: string, referenced: Set<string>): AttachmentIssue[] {
  return referenced.has(filename) ? [] : [{ level: "warning", message: "No media JSON attachment references this file" }];
}
