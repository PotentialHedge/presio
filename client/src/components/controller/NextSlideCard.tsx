import { useEffect } from "react";
import { useElementRef } from "@/hooks/useElementRef";
import { renderPage } from "@/lib/pdf";
import { useRenderTargetWidth } from "@/hooks/useRenderTargetWidth";
import type { Deck } from "@/lib/deck";
import { SlideLayers } from "@/components/plugins/SlideLayers";
import type { PluginHostState } from "@/lib/plugins/usePluginHost";

export function NextSlideCard({
  deck,
  currentSlide,
  plugins,
}: {
  deck: Deck;
  currentSlide: number;
  plugins?: PluginHostState;
}) {
  const { pdf, totalSlides } = deck;
  const [containerRef, container] = useElementRef<HTMLDivElement>();

  // Tracks the resolution this canvas should be rendered at — container size
  // and device pixel ratio both, so browser zoom and a move to a differently
  // scaled monitor re-render rather than upscale.
  const width = useRenderTargetWidth(container);

  useEffect(() => {
    if (!containerRef.current || !width) return;
    const el = containerRef.current;
    if (currentSlide < totalSlides) {
      // Renders resolve out of order (cache hits are near-instant); drop any
      // that finish after the effect has moved to another slide.
      let stale = false;
      // Same rule as the current slide: render at the container's real pixel
      // size so the preview isn't an upscaled fixed-size canvas on HiDPI.
      const targetWidth = width;
      renderPage(pdf, currentSlide + 1, { targetWidth }).then((canvas) => {
        if (stale) return;
        el.innerHTML = "";
        canvas.style.width = "100%";
        canvas.style.height = "100%";
        canvas.style.objectFit = "contain";
        el.appendChild(canvas);
      });
      return () => { stale = true; };
    } else {
      el.innerHTML =
        '<div class="flex items-center justify-center h-full text-muted-foreground text-sm">End of presentation</div>';
    }
    // containerRef is stable; `container` re-runs this for a new element.
  }, [pdf, currentSlide, totalSlides, width, container, containerRef]);

  return (
    <div className="h-full relative rounded overflow-hidden bg-white">
      <div ref={containerRef} className="absolute inset-0" />
      {/* Plugins' still layers: a video's poster, what's drawn on the slide. */}
      {plugins && currentSlide < totalSlides && (
        <SlideLayers plugins={plugins} slide={currentSlide + 1} mode="static" containerRef={containerRef} />
      )}
    </div>
  );
}
