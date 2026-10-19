import { useEffect } from "react";
import { useElementRef } from "@/hooks/useElementRef";
import { renderPageInto } from "@/lib/pdf";
import { useRenderTargetSize } from "@/hooks/useRenderTargetSize";
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
  const { width, height } = useRenderTargetSize(container);

  useEffect(() => {
    if (!containerRef.current || !width) return;
    const el = containerRef.current;
    if (currentSlide < totalSlides) {
      // Same rule as the current slide: render at the container's real pixel
      // size so the preview isn't an upscaled fixed-size canvas on HiDPI.
      return renderPageInto(el, pdf, currentSlide + 1, { targetWidth: width, targetHeight: height });
    } else {
      el.innerHTML =
        '<div class="flex items-center justify-center h-full text-muted-foreground text-sm">End of presentation</div>';
    }
    // containerRef is stable; `container` re-runs this for a new element.
  }, [pdf, currentSlide, totalSlides, width, height, container, containerRef]);

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
