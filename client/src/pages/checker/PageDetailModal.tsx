import { useState, useRef, useEffect } from "react";
import { DialogOverlay } from "@/components/ui/dialog-overlay";
import { Button } from "@/components/ui/button";
import type { PageReport, InspectedAttachment } from "@/lib/inspectAttachments";
import { attachmentMime } from "@shared/attachments";
import { ValidityBadge } from "./ValidityBadge";

type Tab = "notes" | "media";

interface Props {
  pageReport: PageReport;
  thumb: HTMLCanvasElement | undefined;
  /** Initial notes text (original or previously edited). */
  initialNotesValue: string;
  onNotesChange: (page: number, text: string) => void;
  isNotesEdited: boolean;
  /** Set of media JSON filenames queued for deletion. */
  deletedMedia: Set<string>;
  onToggleDeleteMedia: (jsonFilename: string, binaryFilename: string | undefined) => void;
  binaries: Map<string, InspectedAttachment>;
  initialTab?: Tab;
  onClose: () => void;
}

export function PageDetailModal({
  pageReport,
  thumb,
  initialNotesValue,
  onNotesChange,
  isNotesEdited,
  deletedMedia,
  onToggleDeleteMedia,
  binaries,
  initialTab = "notes",
  onClose,
}: Props) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [localNotes, setLocalNotes] = useState(initialNotesValue);
  const blobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => { if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current); };
  }, []);

  function deleteNotes() {
    setLocalNotes("");
    onNotesChange(pageReport.page, "");
  }

  function openMediaJson(attachment: InspectedAttachment) {
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    const blob = new Blob([attachment.content.slice()], { type: "application/json" });
    blobUrlRef.current = URL.createObjectURL(blob);
    window.open(blobUrlRef.current, "_blank", "noopener,noreferrer");
  }

  function openBinary(att: InspectedAttachment) {
    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    // An HTML animation opens as its source: run on this origin, it could act
    // as the signed-in user.
    const blob = new Blob([att.content.slice()], { type: attachmentMime(att.filename) ?? "text/plain" });
    blobUrlRef.current = URL.createObjectURL(blob);
    window.open(blobUrlRef.current, "_blank", "noopener,noreferrer");
  }

  const { page, notes, media } = pageReport;
  const hasNotes = notes !== null;
  const hasMedia = media.length > 0;
  const notesWillBeDeleted = isNotesEdited && localNotes.trim() === "";

  const mediaDeletedCount = media.filter((mj) => deletedMedia.has(mj.filename)).length;

  return (
    <DialogOverlay onClose={onClose} maxWidth="max-w-2xl">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          {thumb && (
            <img
              src={thumb.toDataURL()}
              alt={`Page ${page}`}
              className="h-10 rounded border object-contain shrink-0"
            />
          )}
          <div>
            <p className="text-sm font-medium">Page {page}</p>
            <p className="text-xs text-muted-foreground">
              {[
                hasNotes ? "notes" : null,
                hasMedia ? `${media.length} media` : null,
              ].filter(Boolean).join(" · ") || "no sidecars"}
            </p>
          </div>
        </div>
        <Button size="sm" variant="ghost" onClick={onClose} className="shrink-0 -mt-1 -mr-2">
          ✕
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b -mx-0.5">
        {(["notes", "media"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 text-xs font-medium capitalize border-b-2 transition-colors ${
              tab === t
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t}
            {t === "notes" && isNotesEdited && (
              <span className="ml-1.5 inline-block size-1.5 rounded-full bg-amber-500 align-middle" />
            )}
            {t === "media" && mediaDeletedCount > 0 && (
              <span className="ml-1.5 inline-block size-1.5 rounded-full bg-red-500 align-middle" />
            )}
          </button>
        ))}
      </div>

      {/* Notes tab */}
      {tab === "notes" && (
        <div className="space-y-3">
          {notes && notes.issues.length > 0 && (
            <div className="space-y-1">
              {notes.issues.map((issue, i) => (
                <div
                  key={i}
                  className={`rounded px-2.5 py-1.5 text-xs ${
                    issue.level === "error"
                      ? "bg-red-500/10 text-red-700 dark:text-red-400"
                      : "bg-amber-500/10 text-amber-800 dark:text-amber-400"
                  }`}
                >
                  <span className="font-medium">{issue.level === "error" ? "Error" : "Warning"}:</span>{" "}
                  {issue.message}
                </div>
              ))}
            </div>
          )}

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Speaker notes
              </label>
              <div className="flex items-center gap-2">
                {notes && <ValidityBadge validity={notes.validity} />}
                {notesWillBeDeleted && (
                  <span className="text-xs text-red-600 dark:text-red-400">will be deleted</span>
                )}
                {isNotesEdited && !notesWillBeDeleted && (
                  <span className="text-xs text-amber-700 dark:text-amber-400">edited</span>
                )}
              </div>
            </div>
            <textarea
              className={`w-full min-h-[160px] rounded border bg-muted/30 px-3 py-2 text-sm font-mono resize-y focus:outline-none focus:ring-1 focus:ring-ring ${
                notesWillBeDeleted ? "opacity-40 line-through" : ""
              }`}
              placeholder={hasNotes ? "" : "No notes — type here to add some"}
              value={localNotes}
              onChange={(e) => {
                setLocalNotes(e.target.value);
                onNotesChange(page, e.target.value);
              }}
            />
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                Edits are written as plain text. Use the download button to save.
              </p>
              {hasNotes && !notesWillBeDeleted && (
                <button
                  onClick={deleteNotes}
                  className="text-xs text-red-600 dark:text-red-400 hover:underline underline-offset-2 shrink-0"
                >
                  Delete notes
                </button>
              )}
              {notesWillBeDeleted && (
                <button
                  onClick={() => {
                    const original = notes?.previewText ?? "";
                    setLocalNotes(original);
                    onNotesChange(page, original);
                  }}
                  className="text-xs text-muted-foreground hover:underline underline-offset-2 shrink-0"
                >
                  Undo delete
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Media tab */}
      {tab === "media" && (
        <div className="space-y-3">
          {media.length === 0 ? (
            <p className="text-sm text-muted-foreground">No media attachments on this page.</p>
          ) : (
            media.map((mj, i) => {
              const m = mj.parsed as Record<string, unknown> | undefined;
              const kind = typeof m?.kind === "string" ? m.kind : "—";
              const binaryFilename = typeof m?.filename === "string" ? m.filename : undefined;
              const linkedBinary = binaryFilename ? binaries.get(binaryFilename) : undefined;
              const isDeleted = deletedMedia.has(mj.filename);

              return (
                <div
                  key={i}
                  className={`rounded border p-3 space-y-2 transition-opacity ${isDeleted ? "opacity-50" : ""}`}
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    {isDeleted ? (
                      <span className="inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium bg-red-500/15 text-red-700 dark:text-red-400">
                        Deleted
                      </span>
                    ) : (
                      <ValidityBadge validity={mj.validity} />
                    )}
                    <span className={`text-xs font-mono text-muted-foreground truncate ${isDeleted ? "line-through" : ""}`}>
                      {mj.filename}
                    </span>
                    <span className="text-xs text-muted-foreground ml-auto shrink-0">{kind}</span>
                  </div>

                  {!isDeleted && mj.issues.length > 0 && (
                    <div className="space-y-1">
                      {mj.issues.map((issue, j) => (
                        <div
                          key={j}
                          className={`rounded px-2 py-1 text-xs ${
                            issue.level === "error"
                              ? "bg-red-500/10 text-red-700 dark:text-red-400"
                              : "bg-amber-500/10 text-amber-800 dark:text-amber-400"
                          }`}
                        >
                          <span className="font-medium">{issue.level === "error" ? "Error" : "Warning"}:</span>{" "}
                          {issue.message}
                        </div>
                      ))}
                    </div>
                  )}

                  {!isDeleted && m && (
                    <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                      {(["mime", "x_pt", "y_pt", "w_pt", "h_pt"] as const).map((k) =>
                        m[k] !== undefined ? (
                          <span key={k}>
                            <span className="text-foreground/60">{k}:</span>{" "}
                            {typeof m[k] === "number" ? (m[k] as number).toFixed(1) : String(m[k])}
                          </span>
                        ) : null
                      )}
                      {typeof m.url === "string" && m.url && (
                        <span className="col-span-2 truncate">
                          <span className="text-foreground/60">url:</span> {m.url}
                        </span>
                      )}
                    </div>
                  )}

                  <div className="flex gap-2 flex-wrap items-center">
                    {!isDeleted && (
                      <>
                        <Button size="sm" variant="outline" onClick={() => openMediaJson(mj)}>
                          Open JSON
                        </Button>
                        {linkedBinary && (
                          <Button size="sm" variant="outline" onClick={() => openBinary(linkedBinary)}>
                            Open media file
                          </Button>
                        )}
                      </>
                    )}
                    <button
                      onClick={() => onToggleDeleteMedia(mj.filename, binaryFilename)}
                      className={`ml-auto text-xs hover:underline underline-offset-2 shrink-0 ${
                        isDeleted
                          ? "text-muted-foreground"
                          : "text-red-600 dark:text-red-400"
                      }`}
                    >
                      {isDeleted ? "Undo delete" : "Delete"}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </DialogOverlay>
  );
}
