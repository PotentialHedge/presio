import { useState, useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { loadPdfData, renderPage, destroyPdf } from "@/lib/pdf";
import { setSlideNotes } from "@/lib/notesAttach";
import { removeAttachments } from "@/lib/removeAttachments";
import { inspectAttachments, type DeckReport } from "@/lib/inspectAttachments";
import { attachmentMime } from "@shared/attachments";
import { createLocalDeck } from "@/lib/deckImport";
import { PresioLogo } from "@/components/PresioLogo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ValidityBadge, ValidityDot } from "./ValidityBadge";
import { PageDetailModal } from "./PageDetailModal";
import "@/lib/pdf"; // ensure worker is configured
import { saveFile } from "@/lib/saveFile";
import { track } from "@/lib/analytics";

/** Thumbnails rendered at once. */
const THUMB_CONCURRENCY = 4;

type PageModalState = { page: number; tab: "notes" | "media" } | null;

export default function CheckerPage() {
  const navigate = useNavigate();
  const [filename, setFilename] = useState<string | null>(null);
  const [report, setReport] = useState<DeckReport | null>(null);
  const [thumbs, setThumbs] = useState<Map<number, HTMLCanvasElement>>(new Map());
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [leaveConfirm, setLeaveConfirm] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const [pageModal, setPageModal] = useState<PageModalState>(null);
  // Edits keyed by page number; only set when user has typed something
  const [editedNotes, setEditedNotes] = useState<Map<number, string>>(new Map());
  // Media JSON filenames queued for deletion on download
  const [deletedMedia, setDeletedMedia] = useState<Set<string>>(new Set());
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const pdfBytesRef = useRef<Uint8Array | null>(null);
  // Bumped per loaded (or cleared) file, so a previous file's late work
  // (its report, its thumbnails) never lands in the new one's view.
  const loadGen = useRef(0);

  useEffect(() => {
    return () => {
      // Not a DOM ref: bumping it is the point, so any in-flight load stops.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      loadGen.current++;
      destroyPdf(pdfRef.current);
    };
  }, []);

  const loadFile = useCallback(async (file: File) => {
    if (file.type !== "application/pdf" && !file.name.endsWith(".pdf")) {
      setError("Please upload a PDF file.");
      return;
    }
    const gen = ++loadGen.current;
    setError("");
    setLoading(true);
    setReport(null);
    setThumbs(new Map());
    setFilename(null);
    setEditedNotes(new Map());
    setDeletedMedia(new Set());
    destroyPdf(pdfRef.current);

    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      pdfBytesRef.current = bytes;
      // pdf.js transfers the ArrayBuffer to its worker (detaching it), so pass
      // a copy — the original stored in pdfBytesRef stays intact for download.
      const pdf = await loadPdfData(bytes.slice());
      if (gen !== loadGen.current) {
        destroyPdf(pdf);
        return;
      }
      pdfRef.current = pdf;

      const deck = await inspectAttachments(pdf);
      if (gen !== loadGen.current) return;
      track("check", { slides: pdf.numPages });
      setReport(deck);
      setFilename(file.name);

      // A few pages at a time, in order, and only while this file is current.
      let next = 1;
      const renderNext = async (): Promise<void> => {
        while (next <= pdf.numPages && gen === loadGen.current) {
          const p = next++;
          try {
            const canvas = await renderPage(pdf, p, { targetWidth: 400 });
            if (gen === loadGen.current) setThumbs((prev) => new Map(prev).set(p, canvas));
          } catch {
            // A page that won't render just keeps its placeholder.
          }
        }
      };
      for (let i = 0; i < THUMB_CONCURRENCY; i++) void renderNext();
    } catch (e: unknown) {
      if (gen === loadGen.current) setError(e instanceof Error ? e.message : "Failed to load PDF");
    } finally {
      if (gen === loadGen.current) setLoading(false);
    }
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) loadFile(file);
  }, [loadFile]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      setDragging(true);
    }
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (e.currentTarget === e.target) setDragging(false);
  }, []);

  const onFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) loadFile(file);
    e.target.value = "";
  }, [loadFile]);

  function handleNotesChange(page: number, text: string) {
    setEditedNotes((prev) => new Map(prev).set(page, text));
  }

  function isPageEdited(page: number, originalPreview: string | undefined): boolean {
    if (!editedNotes.has(page)) return false;
    return editedNotes.get(page) !== (originalPreview ?? "");
  }

  function toggleDeleteMedia(jsonFilename: string, binaryFilename: string | undefined) {
    setDeletedMedia((prev) => {
      const next = new Set(prev);
      if (next.has(jsonFilename)) {
        next.delete(jsonFilename);
        if (binaryFilename) next.delete(binaryFilename);
      } else {
        next.add(jsonFilename);
        if (binaryFilename) next.add(binaryFilename);
      }
      return next;
    });
  }

  const hasEdits =
    report !== null &&
    (report.pages.some((pr) => isPageEdited(pr.page, pr.notes?.previewText)) ||
      deletedMedia.size > 0);

  // Block browser tab close / refresh when there are unsaved edits.
  useEffect(() => {
    if (!hasEdits) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasEdits]);

  async function downloadWithEdits() {
    if (!pdfBytesRef.current || !report) return;
    setDownloading(true);
    try {
      let bytes = pdfBytesRef.current;
      for (const pr of report.pages) {
        if (!isPageEdited(pr.page, pr.notes?.previewText)) continue;
        bytes = await setSlideNotes(bytes, pr.page, editedNotes.get(pr.page) ?? "");
      }
      if (deletedMedia.size > 0) {
        bytes = await removeAttachments(bytes, [...deletedMedia]);
      }
      saveFile(new Blob([bytes.slice()], { type: "application/pdf" }), filename ?? "presentation.pdf");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Download failed");
    } finally {
      setDownloading(false);
    }
  }

  const reset = useCallback(() => {
    loadGen.current++;
    destroyPdf(pdfRef.current);
    pdfRef.current = null;
    pdfBytesRef.current = null;
    setReport(null);
    setThumbs(new Map());
    setFilename(null);
    setEditedNotes(new Map());
    setDeletedMedia(new Set());
    setError("");
  }, []);

  const [presenting, setPresenting] = useState(false);

  async function presentPdf() {
    if (!pdfBytesRef.current || !report || !filename) return;
    setPresenting(true);
    try {
      // Apply pending edits/deletions to get the final bytes.
      let bytes = pdfBytesRef.current;
      for (const pr of report.pages) {
        if (!isPageEdited(pr.page, pr.notes?.previewText)) continue;
        bytes = await setSlideNotes(bytes, pr.page, editedNotes.get(pr.page) ?? "");
      }
      if (deletedMedia.size > 0) {
        bytes = await removeAttachments(bytes, [...deletedMedia]);
      }

      // Same as the home screen's import: the deck never leaves the browser,
      // so this works with no connection.
      const id = await createLocalDeck({
        filename: filename.replace(/\.pdf$/i, ""),
        totalSlides: report.pageCount,
        blob: new Blob([bytes.slice()], { type: "application/pdf" }),
      });
      navigate(`/s/${id}/share`);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to open presentation");
      setPresenting(false);
    }
  }

  const activePageReport = pageModal && report
    ? report.pages.find((p) => p.page === pageModal.page) ?? null
    : null;

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 border-b">
        <div className="flex items-center gap-2.5">
          <PresioLogo className="h-6 w-6" />
          <span className="text-sm font-medium tracking-tight">Presio</span>
          <span className="text-muted-foreground text-sm">/</span>
          <span className="text-sm text-muted-foreground">Sidecar checker</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            className="text-xs text-muted-foreground hover:text-foreground transition-colors mr-1"
            onClick={() => hasEdits ? setLeaveConfirm(true) : navigate("/")}
          >
            Back to app
          </button>
          <ThemeToggle />
        </div>
      </header>

      <main className="flex-1 flex flex-col">
        {report === null ? (
          /* Upload screen */
          <div className="flex-1 flex flex-col items-center justify-center p-6 gap-6">
            <div className="text-center space-y-1.5 max-w-sm">
              <h1 className="text-xl font-semibold tracking-tight">Inspect sidecar attachments</h1>
              <p className="text-sm text-muted-foreground">
                Upload a Presio PDF to see per-page thumbnails and validate embedded speaker notes and media sidecars.{" "}
                <a
                  href="https://github.com/benedict-armstrong/presio-typst-package"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-4 hover:text-foreground transition-colors"
                >
                  Typst package
                </a>
              </p>
            </div>

            <label
              className={`w-full max-w-sm cursor-pointer rounded-xl border-2 border-dashed transition-colors flex flex-col items-center justify-center gap-3 p-10 text-center select-none ${
                dragging
                  ? "border-foreground bg-muted/50"
                  : "border-muted-foreground/25 hover:border-muted-foreground/50 hover:bg-muted/30"
              } ${loading ? "pointer-events-none opacity-50" : ""}`}
              onDrop={onDrop}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
            >
              <input
                type="file"
                accept=".pdf,application/pdf"
                className="sr-only"
                onChange={onFileSelect}
                disabled={loading}
              />
              {loading ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : (
                <>
                  <svg
                    width="32"
                    height="32"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    className="text-muted-foreground"
                  >
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                  </svg>
                  <div>
                    <p className="text-sm font-medium">Drop a PDF here</p>
                    <p className="text-xs text-muted-foreground mt-0.5">or click to browse</p>
                  </div>
                </>
              )}
            </label>

            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

            <p className="text-xs text-muted-foreground">The PDF never leaves your browser.</p>
          </div>
        ) : (
          /* Overview screen */
          <div className="flex-1 flex flex-col">
            {/* Summary bar */}
            <div className="border-b px-4 py-3 flex items-center gap-3 flex-wrap">
              <button
                onClick={reset}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors mr-1"
              >
                ← New file
              </button>
              <span className="text-sm font-medium truncate max-w-[20ch]">{filename}</span>
              <span className="text-xs text-muted-foreground">{report.pageCount} pages</span>
              <div className="flex items-center gap-2 ml-auto flex-wrap">
                <SummaryChip label="total" count={report.summary.total} />
                {report.summary.valid > 0 && (
                  <SummaryChip label="valid" count={report.summary.valid} validity="valid" />
                )}
                {report.summary.warning > 0 && (
                  <SummaryChip label="warning" count={report.summary.warning} validity="warning" />
                )}
                {report.summary.invalid > 0 && (
                  <SummaryChip label="invalid" count={report.summary.invalid} validity="invalid" />
                )}
                {report.summary.total === 0 && (
                  <span className="text-xs text-muted-foreground">No sidecar attachments found</span>
                )}
                {hasEdits && (
                  <button
                    onClick={downloadWithEdits}
                    disabled={downloading}
                    className="flex items-center gap-1.5 rounded bg-foreground text-background px-2.5 py-1 text-xs font-medium hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    {downloading ? "Saving…" : "↓ Download with edits"}
                  </button>
                )}
                <button
                  onClick={presentPdf}
                  disabled={presenting}
                  className="flex items-center gap-1 rounded border px-2.5 py-1 text-xs font-medium hover:bg-muted transition-colors disabled:opacity-50"
                >
                  {presenting ? "Opening…" : "▶ Present"}
                </button>
              </div>
            </div>

            {error && (
              <p className="text-sm text-red-600 dark:text-red-400 px-4 pt-2">{error}</p>
            )}

            {/* Page grid */}
            <div className="flex-1 overflow-y-auto p-4">
              <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))" }}>
                {report.pages.map((pr) => {
                  const thumb = thumbs.get(pr.page);
                  const notesEdited = isPageEdited(pr.page, pr.notes?.previewText);
                  const showNotes = pr.notes !== null || notesEdited;

                  return (
                    <div key={pr.page} className="flex flex-col gap-2">
                      {/* Thumbnail — click to open page detail */}
                      <button
                        className="relative rounded-lg overflow-hidden bg-muted border aspect-video flex items-center justify-center hover:ring-2 hover:ring-ring transition-shadow cursor-pointer group"
                        onClick={() => setPageModal({ page: pr.page, tab: "notes" })}
                        title={`Page ${pr.page} — click to inspect`}
                      >
                        {thumb ? (
                          <img
                            src={thumb.toDataURL()}
                            alt={`Page ${pr.page}`}
                            className="w-full h-full object-contain"
                          />
                        ) : (
                          <span className="text-xs text-muted-foreground">…</span>
                        )}
                        {/* Hover overlay */}
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
                          <span className="opacity-0 group-hover:opacity-100 transition-opacity text-[10px] text-white bg-black/60 px-2 py-1 rounded">
                            Inspect
                          </span>
                        </div>
                        <div className="absolute top-1.5 left-1.5 flex items-center gap-1">
                          <span className="text-[10px] bg-black/50 text-white px-1.5 py-0.5 rounded">
                            {pr.page}
                          </span>
                        </div>
                      </button>

                      {/* Attachment buttons */}
                      {(showNotes || pr.media.length > 0) && (
                        <div className="flex flex-col gap-1">
                          {showNotes && (
                            <AttachmentButton
                              label="Notes"
                              validity={pr.notes?.validity ?? "valid"}
                              issues={pr.notes?.issues ?? []}
                              isPendingChange={notesEdited}
                              onClick={() => setPageModal({ page: pr.page, tab: "notes" })}
                            />
                          )}
                          {pr.media.map((mj, i) => {
                            const m = mj.parsed as Record<string, unknown> | undefined;
                            const id = typeof m?.id === "string" ? m.id.slice(0, 20) : `media-${i + 1}`;
                            return (
                              <AttachmentButton
                                key={i}
                                label={`Media: ${id}`}
                                validity={mj.validity}
                                issues={mj.issues}
                                isPendingChange={deletedMedia.has(mj.filename)}
                                onClick={() => setPageModal({ page: pr.page, tab: "media" })}
                              />
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Orphans */}
              {report.orphans.length > 0 && (
                <div className="mt-8 space-y-2">
                  <h2 className="text-sm font-medium">Other files ({report.orphans.length})</h2>
                  {report.orphans.map((a, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <ValidityBadge validity={a.validity} />
                      <span className="text-xs font-mono text-muted-foreground truncate">{a.filename}</span>
                      <button
                        className="ml-auto text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground shrink-0"
                        onClick={() => {
                          if (a.kind === "media-binary") {
                            const ext = a.filename.split(".").pop()?.toLowerCase() ?? "";
                            const mime = ext === "gif" ? "image/gif" : ext === "mp4" ? "video/mp4" : "video/webm";
                            const blob = new Blob([a.content.slice()], { type: mime });
                            const url = URL.createObjectURL(blob);
                            window.open(url, "_blank", "noopener,noreferrer");
                            setTimeout(() => URL.revokeObjectURL(url), 30_000);
                          } else {
                            const blob = new Blob([a.content.slice()], { type: attachmentMime(a.filename) ?? "text/plain" });
                            const url = URL.createObjectURL(blob);
                            window.open(url, "_blank", "noopener,noreferrer");
                            setTimeout(() => URL.revokeObjectURL(url), 30_000);
                          }
                        }}
                      >
                        Open
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {leaveConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={(e) => { if (e.target === e.currentTarget) setLeaveConfirm(false); }}
        >
          <div className="w-full max-w-sm rounded-xl border bg-background p-6 space-y-4 shadow-xl">
            <div className="space-y-1">
              <h2 className="text-sm font-semibold">Unsaved edits</h2>
              <p className="text-sm text-muted-foreground">
                You have unsaved note edits. Download the PDF before leaving or your changes will be lost.
              </p>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setLeaveConfirm(false)}
                className="rounded px-3 py-1.5 text-sm border hover:bg-muted transition-colors"
              >
                Stay
              </button>
              <button
                onClick={() => navigate("/")}
                className="rounded px-3 py-1.5 text-sm bg-destructive text-destructive-foreground hover:opacity-90 transition-opacity"
              >
                Leave anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {pageModal && activePageReport && (
        <PageDetailModal
          pageReport={activePageReport}
          thumb={thumbs.get(pageModal.page)}
          initialNotesValue={
            editedNotes.has(pageModal.page)
              ? (editedNotes.get(pageModal.page) ?? "")
              : (activePageReport.notes?.previewText ?? "")
          }
          onNotesChange={handleNotesChange}
          isNotesEdited={isPageEdited(pageModal.page, activePageReport.notes?.previewText)}
          deletedMedia={deletedMedia}
          onToggleDeleteMedia={toggleDeleteMedia}
          binaries={report?.binaries ?? new Map()}
          initialTab={pageModal.tab}
          onClose={() => setPageModal(null)}
        />
      )}
    </div>
  );
}

function SummaryChip({
  label,
  count,
  validity,
}: {
  label: string;
  count: number;
  validity?: "valid" | "warning" | "invalid";
}) {
  const color =
    validity === "valid"
      ? "text-green-700 dark:text-green-400"
      : validity === "warning"
      ? "text-amber-800 dark:text-amber-400"
      : validity === "invalid"
      ? "text-red-700 dark:text-red-400"
      : "text-muted-foreground";
  return (
    <span className={`text-xs ${color}`}>
      <span className="font-medium">{count}</span> {label}
    </span>
  );
}

function AttachmentButton({
  label,
  validity,
  issues,
  isPendingChange = false,
  onClick,
}: {
  label: string;
  validity: "valid" | "warning" | "invalid";
  issues: { level: "error" | "warning"; message: string }[];
  isPendingChange?: boolean;
  onClick: () => void;
}) {
  const firstIssue = issues[0];
  const colorClass = isPendingChange
    ? "bg-amber-500/15 text-amber-800 dark:text-amber-400 hover:bg-amber-500/25"
    : validity === "invalid"
    ? "bg-red-500/10 text-red-700 dark:text-red-400 hover:bg-red-500/20"
    : validity === "warning"
    ? "bg-amber-500/10 text-amber-800 dark:text-amber-400 hover:bg-amber-500/20"
    : "bg-green-500/10 text-green-700 dark:text-green-400 hover:bg-green-500/20";
  return (
    <button
      onClick={onClick}
      title={firstIssue ? `${firstIssue.level}: ${firstIssue.message}` : undefined}
      className={`flex items-center gap-1.5 rounded px-2 py-1 text-xs text-left w-full transition-colors ${colorClass}`}
    >
      {isPendingChange
        ? <span className="inline-block size-1.5 rounded-full shrink-0 bg-amber-500" />
        : <ValidityDot validity={validity} />}
      <span className="truncate">{label}</span>
      {issues.length > 0 && !isPendingChange && (
        <span className="ml-auto shrink-0 opacity-60">{issues.length}</span>
      )}
    </button>
  );
}
