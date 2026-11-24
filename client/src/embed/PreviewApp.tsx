// The VS Code preview: one deck, shown the way Presio's presenter sees its
// current slide — the page, its links and the plugins' live layers (media,
// drawings) — with the slide strip and the plugins' panels (speaker notes)
// beside it. The extension sends the PDF's bytes, again whenever the file
// changes, so a rebuilt deck shows at once on the slide you were on.

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, GalleryHorizontalEnd, NotebookText, TriangleAlert } from "lucide-react";
import { clearCache, destroyPdf, loadPdfData, renderPageInto } from "@/lib/pdf";
import { loadDeckExtras, makeDeck, type Deck } from "@/lib/deck";
import { inspectAttachments } from "@/lib/inspectAttachments";
import { isEditableTarget, matchesBinding } from "@/lib/keymap";
import { CurrentSlideCard } from "@/components/controller/CurrentSlideCard";
import { ThumbnailsCard } from "@/components/controller/ThumbnailsCard";
import { PluginBackgrounds, PluginButtons, PluginPanel } from "@/components/plugins/PresenterPlugins";
import { Button } from "@/components/ui/button";
import { useElementRef } from "@/hooks/useElementRef";
import { useRenderTargetSize } from "@/hooks/useRenderTargetSize";
import { cn } from "@/lib/utils";
import type { PluginHost } from "@/lib/plugins/host";
import type { PreviewIssue } from "./protocol";
import { onMessage, post, saveDeck, setViewState, viewState } from "./vscode";
import { usePreviewHost } from "./usePreviewHost";

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
  const deck = loaded?.deck ?? null;
  const total = deck?.totalSlides ?? 0;
  const current = total ? Math.min(Math.max(1, slide), total) : 1;

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
      }),
    [show]
  );
  useEffect(() => post({ type: "ready" }), []);

  useEffect(() => {
    setViewState({ slide: current, notes: showNotes, thumbnails: showThumbs });
    if (total) post({ type: "slide", current, total });
  }, [current, total, showNotes, showThumbs]);

  const goTo = useCallback((n: number) => setSlide(() => Math.min(Math.max(1, n), total || 1)), [total]);

  // Keys: Presio's slide navigation, then the plugins' own shortcuts.
  const plugins = host.plugins;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target) || e.ctrlKey || e.altKey) return;
      const nav: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, PageDown: 1, " ": 1, ArrowLeft: -1, ArrowUp: -1, PageUp: -1 };
      if (!e.metaKey && e.key in nav) {
        e.preventDefault();
        goTo(current + (e.shiftKey && e.key === " " ? -1 : nav[e.key]));
        return;
      }
      if (e.key === "Home") return goTo(1);
      if (e.key === "End") return goTo(total);
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
  }, [current, total, goTo, plugins, host.host]);

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
            <div className="h-24 shrink-0 px-2 pb-2">
              <ThumbnailsCard deck={deck} currentSlide={current} onGoTo={goTo} plugins={host} />
            </div>
          )}
          {showNotes && panels.length > 0 && (
            <section className="h-[32%] min-h-24 shrink-0 border-t border-border flex">
              {panels.map(({ plugin, panel }) => (
                <div key={`${plugin.hash}:${panel.id}`} className="flex-1 min-w-0 flex flex-col">
                  <div className="px-3 pt-2 text-[11px] uppercase tracking-wide text-muted-foreground">{panel.title}</div>
                  <div className="flex-1 min-h-0">
                    <PluginPanel host={host.host} plugin={plugin} panel={panel.id} />
                  </div>
                </div>
              ))}
            </section>
          )}
        </main>
      </div>
      <footer className="shrink-0 h-10 px-2 flex items-center gap-1 border-t border-border text-sm">
        <Button variant="ghost" size="icon-sm" title="Slides" aria-pressed={showThumbs} onClick={() => setShowThumbs((v) => !v)} className={cn(showThumbs && "bg-accent")}>
          <GalleryHorizontalEnd className="size-4" />
        </Button>
        <Button variant="ghost" size="icon-sm" title="Previous slide (←)" disabled={current <= 1} onClick={() => goTo(current - 1)}>
          <ChevronLeft className="size-4" />
        </Button>
        <span className="tabular-nums px-1 select-none">
          {current} / {total}
        </span>
        <Button variant="ghost" size="icon-sm" title="Next slide (→)" disabled={current >= total} onClick={() => goTo(current + 1)}>
          <ChevronRight className="size-4" />
        </Button>
        <div className="flex items-center gap-1 ml-2">
          <PluginButtons host={host.host} plugins={plugins} location="controller.currentSlide" />
        </div>
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
        {panels.length > 0 && (
          <Button variant="ghost" size="icon-sm" title="Speaker notes" aria-pressed={showNotes} onClick={() => setShowNotes((v) => !v)} className={cn(showNotes && "bg-accent")}>
            <NotebookText className="size-4" />
          </Button>
        )}
      </footer>
      <PluginBackgrounds host={host.host} plugins={plugins} />
    </div>
  );
}
