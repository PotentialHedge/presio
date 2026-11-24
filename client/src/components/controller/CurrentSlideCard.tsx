import { forwardRef, useEffect, useRef } from "react";
import { ZoomOut } from "lucide-react";
import { SlideLayers } from "@/components/plugins/SlideLayers";
import type { PluginHostState } from "@/lib/plugins/usePluginHost";
import { LinkOverlay } from "@/components/LinkOverlay";
import { useSlidePinchZoom } from "@/hooks/useSlidePinchZoom";
import { Button } from "@/components/ui/button";
import type { PdfLink } from "@/lib/pdfLinks";
import { useContainedCanvasRect } from "@/hooks/useContainedCanvasRect";
import { useElementSize } from "@/hooks/useElementSize";
import { toAudienceZoom, type AudienceZoom } from "@/lib/audienceZoom";

interface Props {
  /** Link annotations on the current slide. */
  links?: PdfLink[];
  /** Where an internal link jumps to. The controller drives the session, so
   *  this is the ordinary slide navigation. */
  onLinkGoTo?: (slide: number) => void;
  /** Reports whether a pinch gesture is running or the slide is zoomed in. */
  onZoomActiveChange?: (active: boolean) => void;
  /** The zoom as the audience should see it (lib/audienceZoom.ts), whenever
   *  it or the slide's place on the card changes. */
  onZoomChange?: (zoom: AudienceZoom) => void;
  /** Plugins' layers on the slide (live "slide" surfaces), and which slide. */
  plugins?: PluginHostState;
  slide?: number;
}

export const CurrentSlideCard = forwardRef<HTMLDivElement, Props>(
  ({ links = [], onLinkGoTo, onZoomActiveChange, onZoomChange, plugins, slide }, ref) => {
    // Pinch to zoom the composed slide (rendered page, links and plugins'
    // layers move together). Local to this device. Two fingers always pinch
    // and pan, even where a plugin's layer is taking input (a drawing tool):
    // SlideLayers hands those touches on to this.
    const surfaceRef = useRef<HTMLDivElement | null>(null);
    const { zoom, reset: resetZoom } = useSlidePinchZoom(surfaceRef, { onActiveChange: onZoomActiveChange });

    const page = useContainedCanvasRect(ref as React.RefObject<HTMLDivElement | null>, slide);
    const surface = useElementSize(surfaceRef);
    useEffect(() => {
      onZoomChange?.(toAudienceZoom(zoom, surface, page));
    }, [onZoomChange, zoom, surface, page]);

    return (
      <div className="h-full flex flex-col gap-1">
        <div
          ref={surfaceRef}
          className="flex-1 min-h-0 relative rounded overflow-hidden bg-white select-none [-webkit-touch-callout:none] touch-none"
        >
          <div
            className="absolute inset-0 will-change-transform"
            style={{
              transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`,
              transformOrigin: "0 0",
            }}
          >
            <div ref={ref} className="absolute inset-0" />
            {/* Inside the zoom transform so links track the slide when the
                presenter pinches in, and above the canvas. */}
            <LinkOverlay
              canvasContainerRef={ref as React.RefObject<HTMLDivElement | null>}
              links={links}
              onGoToSlide={onLinkGoTo}
            />
            {/* Also inside the zoom, so plugin layers stay on the page; above
                the links, which they let through unless they take input. */}
            {plugins && slide !== undefined && (
              <SlideLayers
                plugins={plugins}
                slide={slide}
                mode="live"
                containerRef={ref as React.RefObject<HTMLDivElement | null>}
                zoom={zoom}
              />
            )}
          </div>
          {zoom.scale > 1 && (
            <Button
              type="button"
              size="icon-sm"
              onClick={resetZoom}
              className="absolute right-2 bottom-2 z-10 shadow-md"
              title="Back to fit"
              aria-label="Back to fit"
            >
              <ZoomOut className="size-4" />
            </Button>
          )}
        </div>
      </div>
    );
  }
);
