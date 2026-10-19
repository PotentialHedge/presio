import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useContainedCanvasRect } from "@/hooks/useContainedCanvasRect";
import { FULL_PAGE, FULL_VIEW, type Interactive, type PluginHost, type SlidePage, type SlideView } from "@/lib/plugins/host";
import type { LoadedPlugin } from "@/lib/plugins/manifest";
import type { PluginHostState } from "@/lib/plugins/usePluginHost";
import { PluginFrame } from "./PluginFrame";
import { useFrameHover, useInteractiveRegions, useTouchHandoff } from "./slideSurfaceInput";

// Plugins' layers over a slide — the part every view of a slide shares.
//
//  - "static" views (Next Slide, Thumbnails) draw each plugin's still images
//    (presio.layers): a video's poster, the drawings on a slide.
//  - "live" views (the presenter's current slide, every viewer) mount the
//    plugins' "slide" surfaces instead: frames sized to the page that play,
//    draw and sync. Plugins without one still show their static images.
//
// Positioned over the page: over the letterboxed canvas in `containerRef`,
// or filling the parent when it already has the page's shape (a thumbnail).
// A plugin that asks for the slide area ("slideSurface": "area") gets the
// whole container instead, bars and all, and is told where the page is in it.
// Live layers sit above the slide's link regions: a surface that takes input
// (a drawing tool) must get it first, and one that doesn't lets it through.

/** A pinch-zoom applied to the container (see useSlidePinchZoom). */
export interface LayerZoom {
  scale: number;
  x: number;
  y: number;
}

export function SlideLayers({
  plugins,
  slide,
  mode,
  containerRef,
  zoom,
}: {
  plugins: PluginHostState;
  slide: number;
  mode: "static" | "live";
  containerRef?: React.RefObject<HTMLElement | null>;
  /** The zoom the container is shown at, for "slide" surfaces' view. */
  zoom?: LayerZoom;
}) {
  const { host } = plugins;
  const layers = useSyncExternalStore(host.subscribeLayers, () => host.slideLayers(slide));
  const live = mode === "live" ? plugins.plugins.filter((p) => p.manifest.surfaces.includes("slide")) : [];
  const liveIds = new Set(live.map((p) => p.id));
  // Images of plugins running here only (a viewer may have switched one off).
  const runningIds = new Set(plugins.plugins.map((p) => p.id));
  const stills = layers.filter((l) => runningIds.has(l.pluginId) && !liveIds.has(l.pluginId));
  const onPage = live.filter((p) => p.manifest.slideSurface !== "area");
  const onArea = live.filter((p) => p.manifest.slideSurface === "area");
  if (!stills.length && !live.length) return null;

  const content = (view: SlideView) => (
    <>
      {stills.flatMap((layer) =>
        layer.items.map((item, i) => (
          <img
            key={`${layer.pluginId}:${i}`}
            src={item.image}
            alt=""
            draggable={false}
            className="absolute pointer-events-none select-none"
            style={{
              left: `${item.x * 100}%`,
              top: `${item.y * 100}%`,
              width: `${item.w * 100}%`,
              height: `${item.h * 100}%`,
              objectFit: item.fit,
            }}
          />
        ))
      )}
      {onPage.map((plugin) => (
        <SlideSurface key={plugin.hash} host={host} plugin={plugin} view={view} page={FULL_PAGE} />
      ))}
    </>
  );

  if (!containerRef) return <div className="absolute inset-0 pointer-events-none">{content(FULL_VIEW)}</div>;
  return (
    <>
      <PageBox containerRef={containerRef} slide={slide} zoom={zoom}>{content}</PageBox>
      {onArea.length > 0 && (
        <AreaBox containerRef={containerRef} slide={slide} zoom={zoom}>
          {(view, page) =>
            onArea.map((plugin) => <SlideSurface key={plugin.hash} host={host} plugin={plugin} view={view} page={page} />)
          }
        </AreaBox>
      )}
    </>
  );
}

/** `containerRef`'s box within the parent the layers are positioned in. */
function useContainerBox(containerRef: React.RefObject<HTMLElement | null>) {
  const [box, setBox] = useState({ left: 0, top: 0, width: 0, height: 0 });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () =>
      setBox((b) => {
        const next = { left: el.offsetLeft, top: el.offsetTop, width: el.clientWidth, height: el.clientHeight };
        return next.left === b.left && next.top === b.top && next.width === b.width && next.height === b.height ? b : next;
      });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);
  return box;
}

/**
 * What of a box `width` × `height` (at `left`, `top` in the container) is on
 * screen under the container's pinch-zoom, as fractions of the box. The zoom
 * keeps the container's own box filled, so that's what's on screen.
 */
function visiblePart(zoom: LayerZoom | undefined, container: { width: number; height: number }, box: { left: number; top: number; width: number; height: number }): SlideView {
  if (!zoom || zoom.scale <= 1 || box.width === 0) return FULL_VIEW;
  const left = -zoom.x / zoom.scale;
  const top = -zoom.y / zoom.scale;
  const right = left + container.width / zoom.scale;
  const bottom = top + container.height / zoom.scale;
  const x0 = Math.max(0, (left - box.left) / box.width);
  const y0 = Math.max(0, (top - box.top) / box.height);
  const x1 = Math.min(1, (right - box.left) / box.width);
  const y1 = Math.min(1, (bottom - box.top) / box.height);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0), scale: zoom.scale };
}

/** A box exactly over the page drawn letterboxed in `containerRef`. */
function PageBox({
  containerRef,
  slide,
  zoom,
  children,
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  slide: number;
  zoom?: LayerZoom;
  children: (view: SlideView) => React.ReactNode;
}) {
  const rect = useContainedCanvasRect(containerRef, slide);
  const container = useContainerBox(containerRef);
  const view = useMemo(() => visiblePart(zoom, container, rect), [zoom, container, rect]);
  if (rect.width === 0) return null;
  return (
    <div
      className="absolute z-[5] pointer-events-none"
      style={{ left: container.left + rect.left, top: container.top + rect.top, width: rect.width, height: rect.height }}
    >
      {children(view)}
    </div>
  );
}

/** A box over all of `containerRef`, for surfaces that cover the slide area:
 *  told what of it is on screen and where the page is in it. */
function AreaBox({
  containerRef,
  slide,
  zoom,
  children,
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  slide: number;
  zoom?: LayerZoom;
  children: (view: SlideView, page: SlidePage) => React.ReactNode;
}) {
  const rect = useContainedCanvasRect(containerRef, slide);
  const container = useContainerBox(containerRef);
  const view = useMemo(() => visiblePart(zoom, container, { left: 0, top: 0, width: container.width, height: container.height }), [zoom, container]);
  const page = useMemo<SlidePage>(
    () =>
      container.width && container.height
        ? { x: rect.left / container.width, y: rect.top / container.height, w: rect.width / container.width, h: rect.height / container.height }
        : FULL_PAGE,
    [rect, container]
  );
  if (rect.width === 0 || container.width === 0) return null;
  return (
    <div
      className="absolute z-[5] pointer-events-none"
      style={{ left: container.left, top: container.top, width: container.width, height: container.height }}
    >
      {children(view, page)}
    </div>
  );
}

/**
 * One plugin's live "slide" surface. It lets pointer input through to the
 * slide (links, pinch) unless the plugin claims it: all of it, or only some
 * areas (presio.ui.setInteractive). For areas, a mouse makes the frame take
 * input while it hovers one; a touch, which has no hover, is forwarded into
 * the frame — its pointer events, to the element it began on, and a tap as a
 * click at the same spot. Two fingers are always Presio's: touches
 * that land in a frame taking input are handed on to the slide's pinch-zoom
 * once a second one comes down.
 */
function SlideSurface({ host, plugin, view, page }: { host: PluginHost; plugin: LoadedPlugin; view: SlideView; page: SlidePage }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [interactive, setInteractive] = useState<Interactive>(false);
  const [hot, setHot] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [readyCount, setReadyCount] = useState(0);
  const regions = useMemo(() => (Array.isArray(interactive) ? interactive : null), [interactive]);
  const presenter = host.context.role === "presenter";

  useFrameHover(frameRef, presenter, readyCount, setHovered);

  const penOnly = interactive === "pen";
  useTouchHandoff(frameRef, presenter, readyCount, penOnly);

  useInteractiveRegions(frameRef, regions, readyCount, setHot);

  const takesInput = interactive === true || penOnly || (!!regions && hot);
  return (
    <>
      {/* Under the frame, over its input areas: here a touch that starts on
          one can't turn into the browser's pan, which would cancel it. */}
      {regions?.map((r, i) => (
        <div
          key={i}
          aria-hidden
          className="absolute pointer-events-auto touch-none"
          style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}
        />
      ))}
      <PluginFrame
        host={host}
        plugin={plugin}
        surface="slide"
        frameRef={frameRef}
        onInteractiveChange={(v) => {
          setInteractive(v);
          setHot(false);
        }}
        onReady={() => setReadyCount((n) => n + 1)}
        view={view}
        page={page}
        hovered={presenter ? hovered : undefined}
        className="absolute inset-0 w-full h-full"
        style={{ pointerEvents: takesInput ? "auto" : "none" }}
      />
    </>
  );
}
