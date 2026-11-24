// The VS Code preview: one deck, shown the way Presio's presenter sees its
// current slide — the page, its links and the plugins' live layers (media,
// drawings) — with the slide strip and the plugins' panels (speaker notes)
// beside it. The extension sends the PDF's bytes, again whenever the file
// changes, so a rebuilt deck shows at once on the slide you were on.

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, ExternalLink, GalleryHorizontalEnd, NotebookText, TriangleAlert } from "lucide-react";
import { clearCache, destroyPdf, loadPdfData, renderPageInto } from "@/lib/pdf";
import { loadDeckExtras, makeDeck, type Deck } from "@/lib/deck";
import { inspectAttachments } from "@/lib/inspectAttachments";
import { DEFAULT_KEYMAP, isEditableTarget, matchesBinding } from "@/lib/keymap";
import { nextSectionStart, prevSectionStart } from "@/lib/sections";
import { CurrentSlideCard } from "@/components/controller/CurrentSlideCard";
import { ThumbnailsCard } from "@/components/controller/ThumbnailsCard";
import { PluginBackgrounds, PluginPanel } from "@/components/plugins/PresenterPlugins";
import { Button } from "@/components/ui/button";
import { useElementRef } from "@/hooks/useElementRef";
import { useLatestRef } from "@/hooks/useLatestRef";
import { useRenderTargetSize } from "@/hooks/useRenderTargetSize";
import { cn } from "@/lib/utils";
import type { PluginHost } from "@/lib/plugins/host";
import type { PreviewIssue } from "./protocol";
import { onMessage, post, saveDeck, setViewState, viewState } from "./vscode";
import { usePreviewHost } from "./usePreviewHost";
import { ResizablePanel } from "./ResizablePanel";
import { PluginToggles, ToggleButton } from "./ToggleButton";

/** The panels' heights (CSS px): to start with, and below which a drag closes them. */
const NOTES = { height: 220, min: 72 };
const THUMBS = { height: 96, min: 56 };

interface Loaded {
  deck: Deck;
  id: string;
}

export function PreviewApp() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [issues, setIssues] = useState<PreviewIssue[]>([]);
  const initial = viewState();
  const [slide, setSlide] = useState(initial.slide ?? 1);
  const [showNotes, setShowNotes] = useState(initial.notes ?? true);
  const [showThumbs, setShowThumbs] = useState(initial.thumbnails ?? false);
  const [notesHeight, setNotesHeight] = useState(initial.notesHeight ?? NOTES.height);
  const [thumbsHeight, setThumbsHeight] = useState(initial.thumbsHeight ?? THUMBS.height);
  const deck = loaded?.deck ?? null;
  const total = deck?.totalSlides ?? 0;
  const current = total ? Math.min(Math.max(1, slide), total) : 1;
  // For answering the extension's "Open in Presio" request.
  const currentRef = useLatestRef(current);

  // Swap in a new document: the next deck from the extension, or one a plugin
  // just saved. The old one is freed once the new one is showing.
  const loadedRef = useRef<Loaded | null>(null);
  const hostRef = useRef<PluginHost | null>(null);
  const show = useCallback(async (bytes: Uint8Array, filename: string, id: string, edit = false) => {
    let pdf;
    try {
      // A copy: pdf.js takes the buffer over.
      pdf = await loadPdfData(bytes.slice());
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setLoadError(message);
      post({ type: "loadError", message });
      return;
    }
    const extras = await loadDeckExtras(pdf);
    const prev = loadedRef.current;
    clearCache();
    // Same pages, edited: plugins keep what they hang off them.
    if (edit) hostRef.current?.expectDeckEdit();
    const next = { deck: makeDeck(pdf, "", filename, extras), id };
    loadedRef.current = next;
    setLoaded(next);
    setLoadError(null);
    if (prev && prev.deck.pdf !== pdf) destroyPdf(prev.deck.pdf);

    const report = await inspectAttachments(pdf).catch(() => null);
    if (loadedRef.current !== next || !report) return;
    const found: PreviewIssue[] = [];
    const attachments = [...report.pages.flatMap((p) => [...(p.notes ? [p.notes] : []), ...p.media]), ...report.orphans];
    for (const a of attachments) {
      for (const issue of a.issues) found.push({ ...issue, filename: a.filename, slide: a.slide });
    }
    setIssues(found);
    post({ type: "report", issues: found });
  }, []);

  const host = usePreviewHost({
    sessionId: loaded ? `vscode:${loaded.id}` : "vscode",
    pdf: deck?.pdf ?? null,
    currentSlide: current,
    totalSlides: total,
    save: useCallback(
      async (bytes: Uint8Array) => {
        const now = loadedRef.current;
        if (!now) throw new Error("No deck is open");
        await saveDeck(bytes);
        await show(bytes, now.deck.filename, now.id, true);
      },
      [show]
    ),
  });
  useEffect(() => {
    hostRef.current = host.host;
  }, [host.host]);

  useEffect(
    () =>
      onMessage((m) => {
        if (m.type === "deck") void show(m.bytes, m.filename, m.id);
        else if (m.type === "goTo") setSlide(m.slide);
        else if (m.type === "openInPresio") post({ type: "openInPresio", slide: currentRef.current });
      }),
    [show, currentRef]
  );
  useEffect(() => post({ type: "ready" }), []);

  useEffect(() => {
    setViewState({ slide: current, notes: showNotes, thumbnails: showThumbs, notesHeight, thumbsHeight });
  }, [current, showNotes, showThumbs, notesHeight, thumbsHeight]);

  const goTo = useCallback((n: number) => setSlide(() => Math.min(Math.max(1, n), total || 1)), [total]);

  // Keys: Presio's (its default keymap, plus ↑/↓, ⇧Space and Home/End),
  // then the plugins' own shortcuts.
  const plugins = host.plugins;
  const sections = deck?.sections;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target) || e.ctrlKey) return;
      const plain = !e.metaKey && !e.altKey;
      const sectionsHere = sections ?? [];
      const to =
        matchesBinding(e, DEFAULT_KEYMAP.firstSlide) || (plain && e.key === "Home") ? 1
        : matchesBinding(e, DEFAULT_KEYMAP.lastSlide) || (plain && e.key === "End") ? total
        : matchesBinding(e, DEFAULT_KEYMAP.nextSection) ? nextSectionStart(sectionsHere, current)
        : matchesBinding(e, DEFAULT_KEYMAP.prevSection) ? prevSectionStart(sectionsHere, current)
        : plain && e.shiftKey && e.key === " " ? current - 1
        : matchesBinding(e, DEFAULT_KEYMAP.nextSlide) || (plain && e.key === "ArrowDown") ? current + 1
        : matchesBinding(e, DEFAULT_KEYMAP.prevSlide) || (plain && e.key === "ArrowUp") ? current - 1
        : undefined;
      if (to !== undefined) {
        e.preventDefault();
        if (to !== null) goTo(to);
        return;
      }
      for (const plugin of plugins) {
        const kb = plugin.manifest.contributes.keybindings.find((k) => matchesBinding(e, k.keys));
        if (!kb) continue;
        e.preventDefault();
        host.host.runCommand(plugin.id, kb.command);
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, total, sections, goTo, plugins, host.host]);

  // The current page, drawn at the stage's pixel size.
  const [canvasRef, canvasEl] = useElementRef<HTMLDivElement>();
  const size = useRenderTargetSize(canvasEl, !!deck);
  useEffect(() => {
    if (!deck || !canvasEl || !size.width) return;
    return renderPageInto(canvasEl, deck.pdf, current, { targetWidth: size.width, targetHeight: size.height });
  }, [deck, current, canvasEl, size.width, size.height]);

  const panels = plugins.flatMap((plugin) => plugin.manifest.contributes.panels.map((panel) => ({ plugin, panel })));
  const errors = issues.filter((i) => i.level === "error").length;

  if (!deck) {
    return (
      <div className="h-full grid place-items-center text-sm text-muted-foreground p-6 text-center">
        {loadError ? `Couldn't open this PDF: ${loadError}` : "Opening…"}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="flex-1 min-h-0 flex">
        <main className="flex-1 min-w-0 flex flex-col">
          <div className="flex-1 min-h-0 p-3">
            <CurrentSlideCard
              ref={canvasRef}
              links={deck.linksBySlide.get(current) ?? []}
              onLinkGoTo={goTo}
              plugins={host}
              slide={current}
            />
          </div>
          {showThumbs && (
            <ResizablePanel
              height={thumbsHeight}
              min={THUMBS.min}
              onResize={setThumbsHeight}
              onClose={() => setShowThumbs(false)}
              className="px-2 pb-2"
            >
              <ThumbnailsCard deck={deck} currentSlide={current} onGoTo={goTo} plugins={host} />
            </ResizablePanel>
          )}
          {showNotes && panels.length > 0 && (
            <ResizablePanel
              height={notesHeight}
              min={NOTES.min}
              onResize={setNotesHeight}
              onClose={() => setShowNotes(false)}
              className="border-t border-border flex"
            >
              {panels.map(({ plugin, panel }) => (
                <div key={`${plugin.hash}:${panel.id}`} className="flex-1 min-w-0 flex flex-col">
                  <div className="px-3 pt-2 text-[11px] uppercase tracking-wide text-muted-foreground">{panel.title}</div>
                  <div className="flex-1 min-h-0">
                    <PluginPanel host={host.host} plugin={plugin} panel={panel.id} />
                  </div>
                </div>
              ))}
            </ResizablePanel>
          )}
        </main>
      </div>
      <footer className="shrink-0 h-10 px-2 flex items-center gap-1 border-t border-border text-sm">
        {/* Left: what's shown around the slide. */}
        <ToggleButton icon={GalleryHorizontalEnd} label="Slides" active={showThumbs} onClick={() => setShowThumbs((v) => !v)} />
        {panels.length > 0 && (
          <ToggleButton icon={NotebookText} label="Speaker notes" active={showNotes} onClick={() => setShowNotes((v) => !v)} />
        )}
        <PluginToggles host={host.host} plugins={plugins} />
        <div className="flex-1" />
        {loadError && (
          <span className="text-xs text-muted-foreground truncate" title={loadError}>
            Couldn't reload: showing the last version that opened
          </span>
        )}
        {issues.length > 0 && (
          <span
            className="flex items-center gap-1 text-xs text-muted-foreground px-1"
            title={issues.map((i) => `${i.filename}: ${i.message}`).join("\n")}
          >
            <TriangleAlert className={cn("size-3.5", errors && "text-destructive")} />
            {issues.length}
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          title="Open this deck in Presio, in the browser, on this slide"
          onClick={() => post({ type: "openInPresio", slide: current })}
        >
          <ExternalLink className="size-3.5" />
          Open in Presio
        </Button>
        {/* Right: moving through the deck. */}
        <Button variant="ghost" size="icon-sm" title="Previous slide (←)" disabled={current <= 1} onClick={() => goTo(current - 1)}>
          <ChevronLeft className="size-4" />
        </Button>
        <span className="tabular-nums px-1 select-none">
          {current} / {total}
        </span>
        <Button variant="ghost" size="icon-sm" title="Next slide (→)" disabled={current >= total} onClick={() => goTo(current + 1)}>
          <ChevronRight className="size-4" />
        </Button>
      </footer>
      <PluginBackgrounds host={host.host} plugins={plugins} />
    </div>
  );
}
