// Strict sidecar inspection for the PDF checker tool (validators in
// shared/sidecar.ts, which POST /api/check uses too).

import type { PDFDocumentProxy } from "pdfjs-dist";
import { readAttachments } from "./pdf";
import { unusualAttachmentWarning } from "@shared/attachments";
import {
  binaryIssues,
  checkMediaJson,
  checkNotes,
  MEDIA_BINARY_RE,
  MEDIA_JSON_RE,
  NOTES_RE,
  referencedBinaries,
  validityOf,
  type AttachmentIssue,
  type Validity,
} from "@shared/sidecar";

export type { AttachmentIssue, Validity };

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

  const referenced = referencedBinaries(entries);

  // Classify and inspect
  const notesMap = new Map<number, InspectedAttachment>();
  const mediaMap = new Map<number, InspectedAttachment[]>();
  const binaries = new Map<string, InspectedAttachment>();
  const orphans: InspectedAttachment[] = [];

  for (const { filename, content } of entries) {
    if (NOTES_RE.test(filename)) {
      const { markdown, ...check } = checkNotes(filename, content, pageCount);
      const a: InspectedAttachment = { filename, kind: "notes", content, previewText: markdown, ...check };
      if (a.slide !== undefined) {
        notesMap.set(a.slide, a);
      } else {
        orphans.push(a);
      }
    } else if (MEDIA_JSON_RE.test(filename)) {
      const a: InspectedAttachment = { filename, kind: "media-json", content, ...checkMediaJson(filename, content, pageCount, allNames) };
      const slide = a.slide;
      if (slide !== undefined) {
        const arr = mediaMap.get(slide) ?? [];
        arr.push(a);
        mediaMap.set(slide, arr);
      } else {
        orphans.push(a);
      }
    } else if (MEDIA_BINARY_RE.test(filename)) {
      const issues = binaryIssues(filename, referenced);
      const a: InspectedAttachment = { filename, kind: "media-binary", validity: validityOf(issues), issues, content };
      binaries.set(filename, a);
      if (!referenced.has(filename)) {
        orphans.push(a);
      }
    } else {
      // Not one of Presio's own sidecars: a plugin's file, fine when it's JSON,
      // an image or a video.
      const warning = unusualAttachmentWarning(filename);
      const issues: AttachmentIssue[] = warning ? [{ level: "warning", message: warning }] : [];
      orphans.push({ filename, kind: "unknown", validity: validityOf(issues), issues, content });
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
