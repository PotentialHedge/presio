import { useEffect, useRef, useState } from "react";
import { renderPage } from "@/lib/pdf";
import type { Deck } from "@/lib/deck";
import { SlideLayers } from "@/components/plugins/SlideLayers";
import { PluginThumbnailMenuItems } from "@/components/plugins/PresenterPlugins";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuLabel, ContextMenuTrigger } from "@/components/ui/context-menu";
import type { PluginHostState } from "@/lib/plugins/usePluginHost";

export function ThumbnailsCard({
  deck,
  currentSlide,
  onGoTo,
  plugins,
}: {
  deck: Deck;
  currentSlide: number;
  onGoTo: (slide: number) => void;
  plugins?: PluginHostState;
}) {
  const { pdf, totalSlides } = deck;
  const containerRef = useRef<HTMLDivElement>(null);
  const thumbRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [aspectRatio, setAspectRatio] = useState<number | null>(null);
  // The thumbnail a context menu was opened on (right-click, long press).
  const [menuSlide, setMenuSlide] = useState<number | null>(null);
  // Only plugins add to the menu (thumbnail.context): without any, a
  // right-click stays the browser's.
  const hasMenu = !!plugins?.plugins.some((p) => p.manifest.contributes.buttons.some((b) => b.location === "thumbnail.context"));

  useEffect(() => {
    pdf.getPage(1).then((page) => {
      const vp = page.getViewport({ scale: 1 });
      setAspectRatio(vp.width / vp.height);
    });
  }, [pdf]);

  // The canvas is rendered at the tile's pixel size, so a tile that grows would
  // otherwise keep showing the old, smaller canvas upscaled. Track the width
  // and let the render effect below re-run when it changes. Quantised to 32px
  // steps so dragging a mosaic divider re-renders a handful of times rather
  // than on every pixel.
  const [tileWidth, setTileWidth] = useState(0);
  useEffect(() => {
    // Wait for the page aspect ratio: until it lands the tiles are just their
    // 80px minWidth, so measuring now would render every thumbnail at that
    // size and — since the container itself never resizes when the tiles grow
    // — leave them upscaled for good.
    if (!aspectRatio) return;
    const tile = thumbRefs.current.values().next().value;
    if (!tile) return;
    const measure = () => {
      if (tile.clientWidth) setTileWidth(Math.ceil(tile.clientWidth / 32) * 32);
    };
    measure();
    // Observe a tile rather than the scroll container: the tile changes size
    // both when the pane is resized and when the aspect ratio arrives.
    const ro = new ResizeObserver(measure);
    ro.observe(tile);
    return () => ro.disconnect();
  }, [totalSlides, aspectRatio]);

  useEffect(() => {
    if (!tileWidth) return;
    // A swapped document (notes edit, deck replace) invalidates every rendered
    // thumbnail: drop the old canvases so the observer below re-renders them
    // from the new document instead of keeping whatever was on screen.
    thumbRefs.current.forEach((el) => {
      el.innerHTML = "";
    });
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          const pageNum = Number((entry.target as HTMLElement).dataset.page);
          if (!pageNum) return;
          // Match the tile's real pixel size rather than a fixed multiplier:
          // `scale` is relative to PDF points, so a fixed one renders a beamer
          // deck half the size of a wide one and upscales on HiDPI either way.
          const el = entry.target as HTMLDivElement;
          const targetWidth = Math.round(tileWidth * (window.devicePixelRatio || 1));
          renderPage(pdf, pageNum, { targetWidth }).then((canvas) => {
            if (el.childElementCount > 0) return;
            canvas.style.width = "100%";
            canvas.style.height = "100%";
            canvas.style.objectFit = "contain";
            el.appendChild(canvas);
          });
          observer.unobserve(entry.target);
        });
      },
      { root: containerRef.current, threshold: 0.1 }
    );
    thumbRefs.current.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [pdf, totalSlides, tileWidth]);

  useEffect(() => {
    const el = thumbRefs.current.get(currentSlide);
    el?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }, [currentSlide]);

  const strip = (
    <div
      ref={containerRef}
      className="flex gap-2 overflow-x-auto h-full items-start p-1"
    >
      {Array.from({ length: totalSlides }, (_, i) => i + 1).map((num) => (
        <button
          key={num}
          type="button"
          data-thumbnail={num}
          onClick={() => onGoTo(num)}
          className={`relative shrink-0 h-full rounded border overflow-hidden transition-all ${
            num === currentSlide
              ? "ring-2 ring-red-500 border-red-500"
              : "border-border hover:border-foreground/30"
          }`}
          style={aspectRatio ? { aspectRatio, minWidth: 80 } : { minWidth: 80 }}
        >
          <div
            ref={(el) => {
              if (el) thumbRefs.current.set(num, el);
              else thumbRefs.current.delete(num);
            }}
            data-page={num}
            className="w-full h-full"
          />
          {/* The tile has the page's shape, so layers just fill it. */}
          {plugins && <SlideLayers plugins={plugins} slide={num} mode="static" />}
        </button>
      ))}
    </div>
  );
  // Always wrapped, so plugins arriving later don't remount the strip (and
  // drop its rendered thumbnails); the menu is off until one adds to it.
  return (
    <ContextMenu onOpenChange={(open) => { if (!open) setMenuSlide(null); }}>
      <ContextMenuTrigger
        asChild
        disabled={!plugins || !hasMenu}
        onContextMenu={(e) => {
          const thumb = (e.target as HTMLElement).closest<HTMLElement>("[data-thumbnail]");
          // Off a thumbnail (the strip's empty end) there's nothing to act on.
          if (!thumb) return e.preventDefault();
          setMenuSlide(Number(thumb.dataset.thumbnail));
        }}
      >
        {strip}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-48" data-testid="thumbnail-menu">
        {menuSlide !== null && plugins && (
          <>
            <ContextMenuLabel>Slide {menuSlide}</ContextMenuLabel>
            <ContextMenuItem onSelect={() => onGoTo(menuSlide)}>Go to slide</ContextMenuItem>
            <PluginThumbnailMenuItems host={plugins.host} plugins={plugins.plugins} slide={menuSlide} />
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
