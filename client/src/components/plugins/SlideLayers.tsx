import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useContainedCanvasRect } from "@/hooks/useContainedCanvasRect";
import { FULL_PAGE, FULL_VIEW, type Interactive, type PluginHost, type SlidePage, type SlideView } from "@/lib/plugins/host";
import type { LoadedPlugin } from "@/lib/plugins/manifest";
import type { PluginHostState } from "@/lib/plugins/usePluginHost";
import { PluginFrame } from "./PluginFrame";

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

type Region = { x: number; y: number; w: number; h: number };

const inside = (regions: Region[], fx: number, fy: number) =>
  regions.some((r) => fx >= r.x && fx <= r.x + r.w && fy >= r.y && fy <= r.y + r.h);

/** Whether nothing covers the frame at this point (a dialog, a menu): only
 *  then is a tap there meant for it. */
function onTop(frame: HTMLIFrameElement, x: number, y: number): boolean {
  const before = frame.style.pointerEvents;
  frame.style.pointerEvents = "auto";
  const hit = document.elementFromPoint(x, y);
  frame.style.pointerEvents = before;
  return hit === frame;
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
/** "pen" mode: touches this soon after the pen lifts are still the hand. */
const PALM_QUIET_MS = 250;
/** "pen" mode: what in a plugin's frame a finger works, rather than the slide. */
const PLUGIN_CONTROL = "button, a, input, select, textarea, [role='button'], [data-control]";
/** "pen" mode: a finger's tap, forwarded as a click to a link on the slide. */
const TAP_MS = 500;
const TAP_SLOP_PX = 10;

function SlideSurface({ host, plugin, view, page }: { host: PluginHost; plugin: LoadedPlugin; view: SlideView; page: SlidePage }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [interactive, setInteractive] = useState<Interactive>(false);
  const [hot, setHot] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [readyCount, setReadyCount] = useState(0);
  const regions = useMemo(() => (Array.isArray(interactive) ? interactive : null), [interactive]);
  const presenter = host.context.role === "presenter";

  // Whether a mouse is over the page (presio.ui.onHover): over the frame when
  // it takes input, over what's under it when it doesn't. The presenter's
  // only — it's for their own controls.
  useEffect(() => {
    const frame = frameRef.current;
    if (!presenter || !frame) return;
    let leaving: ReturnType<typeof setTimeout> | null = null;
    const settle = (over: boolean) => {
      if (leaving) clearTimeout(leaving);
      leaving = null;
      setHovered(over);
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      const box = frame.getBoundingClientRect();
      settle(e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom);
    };
    const onOut = (e: PointerEvent) => {
      if (e.pointerType === "mouse" && !e.relatedTarget) settle(false);
    };
    // Leaving the frame looks the same whether the mouse went to the page
    // around it or out of the window; the page's own pointermove says which.
    const onInnerMove = (e: PointerEvent) => {
      if (e.pointerType === "mouse") settle(true);
    };
    const onInnerLeave = () => {
      if (leaving) clearTimeout(leaving);
      leaving = setTimeout(() => setHovered(false), 80);
    };
    const inner = frame.contentWindow;
    window.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerout", onOut);
    inner?.addEventListener("pointermove", onInnerMove);
    inner?.document.documentElement.addEventListener("pointerleave", onInnerLeave);
    return () => {
      if (leaving) clearTimeout(leaving);
      window.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerout", onOut);
      inner?.removeEventListener("pointermove", onInnerMove);
      inner?.document.documentElement.removeEventListener("pointerleave", onInnerLeave);
    };
  }, [presenter, readyCount]);

  // Touches the frame took, passed on to the page once two are down: the
  // pinch-zoom (useSlidePinchZoom) listens above the frame, where input that
  // lands inside it never arrives. One finger stays the plugin's — except in
  // "pen" mode, where every finger is passed on from the start (to pan, pinch
  // and turn the page) and only a pen's input is the plugin's. There, a touch
  // while the pen is down, or just after, is a hand resting on the screen:
  // it's never passed on, and a pen landing ends what fingers had begun.
  const penOnly = interactive === "pen";
  const penOnlyRef = useRef(penOnly);
  useEffect(() => {
    penOnlyRef.current = penOnly;
  }, [penOnly]);
  useEffect(() => {
    const frame = frameRef.current;
    const inner = frame?.contentWindow;
    if (!presenter || !frame || !inner) return;
    const down = new Map<number, PointerEvent>();
    let forwarding = false;
    let pens = 0;
    let penAt = -Infinity;
    // "pen" mode: a lone finger's tap, which a link under it takes as a click.
    let tap: { id: number; x: number; y: number; t: number; target: Element | null } | null = null;
    const forward = (type: string, e: PointerEvent): Element | null => {
      const box = frame.getBoundingClientRect();
      const scale = frame.clientWidth ? box.width / frame.clientWidth : 1;
      const x = box.left + e.clientX * scale;
      const y = box.top + e.clientY * scale;
      // To what the touch would have landed on without the frame (the slide,
      // which turns the page on a tap), else to the frame's box; both bubble
      // up to the pinch-zoom.
      const layer = frame.parentElement;
      const stack = document.elementsFromPoint(x, y);
      const at = stack.indexOf(frame);
      const under = at < 0 ? null : stack.slice(at + 1).find((el) => !layer?.contains(el));
      const target = under ?? layer;
      target?.dispatchEvent(
        new PointerEvent(type, {
          pointerId: e.pointerId,
          pointerType: "touch",
          isPrimary: e.isPrimary,
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        })
      );
      return target ?? null;
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "pen") {
        pens++;
        penAt = performance.now();
        tap = null;
        if (penOnlyRef.current && forwarding) for (const d of down.values()) forward("pointercancel", d);
        if (penOnlyRef.current) {
          down.clear();
          forwarding = false;
        }
        return;
      }
      if (e.pointerType !== "touch") return;
      if (penOnlyRef.current && (pens > 0 || performance.now() - penAt < PALM_QUIET_MS)) return;
      // The plugin's own controls (its buttons, a handle to drag) take a
      // finger even in "pen" mode. (The target is the frame's own: not an
      // instance of this window's Element, so it's duck-typed.)
      const own = e.target as Element | null;
      if (penOnlyRef.current && down.size === 0 && typeof own?.closest === "function" && own.closest(PLUGIN_CONTROL)) return;
      down.set(e.pointerId, e);
      tap = null;
      if (forwarding) forward("pointerdown", e);
      else if (down.size >= 2 || penOnlyRef.current) {
        forwarding = true;
        for (const d of down.values()) {
          const target = forward("pointerdown", d);
          if (down.size === 1) tap = { id: d.pointerId, x: d.clientX, y: d.clientY, t: performance.now(), target };
        }
      }
    };
    const onMove = (e: PointerEvent) => {
      if (!down.has(e.pointerId)) return;
      down.set(e.pointerId, e);
      if (forwarding) forward("pointermove", e);
    };
    const onEnd = (e: PointerEvent) => {
      if (e.pointerType === "pen") {
        pens = Math.max(0, pens - 1);
        penAt = performance.now();
        return;
      }
      if (!down.delete(e.pointerId)) return;
      if (forwarding) forward(e.type, e);
      if (!down.size) forwarding = false;
      // Synthetic pointer events make no click of their own: a quick, still
      // tap on a link (or another control on the slide) gets one.
      const t = tap;
      tap = null;
      if (
        t?.id === e.pointerId &&
        e.type === "pointerup" &&
        performance.now() - t.t < TAP_MS &&
        Math.hypot(e.clientX - t.x, e.clientY - t.y) < TAP_SLOP_PX
      ) {
        const control = t.target?.closest("a, button, [role='button']");
        if (control instanceof HTMLElement) control.click();
      }
    };
    inner.addEventListener("pointerdown", onDown, true);
    inner.addEventListener("pointermove", onMove, true);
    inner.addEventListener("pointerup", onEnd, true);
    inner.addEventListener("pointercancel", onEnd, true);
    return () => {
      inner.removeEventListener("pointerdown", onDown, true);
      inner.removeEventListener("pointermove", onMove, true);
      inner.removeEventListener("pointerup", onEnd, true);
      inner.removeEventListener("pointercancel", onEnd, true);
    };
  }, [presenter, readyCount]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!regions || !frame) return;
    const fraction = (clientX: number, clientY: number) => {
      const box = frame.getBoundingClientRect();
      return [(clientX - box.left) / box.width, (clientY - box.top) / box.height] as const;
    };
    const elementAt = (fx: number, fy: number) =>
      frame.contentDocument?.elementFromPoint(fx * frame.clientWidth, fy * frame.clientHeight);
    // Outside the frame's own input: where the pointer is over the page.
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== "mouse") return;
      setHot(inside(regions, ...fraction(e.clientX, e.clientY)));
    };
    // A touch on one of the areas is the plugin's, so the slide under it
    // mustn't take it too (as a tap to turn the page). It has no hover to
    // make the frame take input first, so its pointer events are forwarded
    // into the frame instead — all to the element it began on, as a touch's
    // are — and a tap arrives as a click (below). A second finger ends it:
    // two are for pinching.
    let touch: { id: number; target: Element } | null = null;
    const forward = (type: string, e: PointerEvent, target: Element) => {
      const inner = frame.contentWindow as (Window & typeof globalThis) | null;
      if (!inner) return;
      const [fx, fy] = fraction(e.clientX, e.clientY);
      target.dispatchEvent(
        new inner.PointerEvent(type, {
          pointerId: e.pointerId,
          pointerType: e.pointerType,
          isPrimary: e.isPrimary,
          button: e.button,
          buttons: e.buttons,
          clientX: fx * frame.clientWidth,
          clientY: fy * frame.clientHeight,
          bubbles: true,
          cancelable: true,
          view: inner,
        })
      );
    };
    const onDown = (e: PointerEvent) => {
      if (e.pointerType === "mouse") return;
      if (touch) {
        if (e.pointerId !== touch.id) {
          forward("pointercancel", e, touch.target);
          touch = null;
        }
        return;
      }
      const [fx, fy] = fraction(e.clientX, e.clientY);
      if (!inside(regions, fx, fy) || !onTop(frame, e.clientX, e.clientY)) return;
      e.stopPropagation();
      const target = elementAt(fx, fy);
      if (!target || !e.isPrimary) return;
      touch = { id: e.pointerId, target };
      forward("pointerdown", e, target);
    };
    const onTouchMove = (e: PointerEvent) => {
      if (!touch || e.pointerId !== touch.id) return;
      e.stopPropagation();
      forward("pointermove", e, touch.target);
    };
    const onTouchEnd = (e: PointerEvent) => {
      if (!touch || e.pointerId !== touch.id) return;
      e.stopPropagation();
      forward(e.type, e, touch.target);
      touch = null;
    };
    const onClick = (e: MouseEvent) => {
      const [fx, fy] = fraction(e.clientX, e.clientY);
      if (!inside(regions, fx, fy) || !onTop(frame, e.clientX, e.clientY)) return;
      const target = elementAt(fx, fy);
      if (!target) return;
      e.preventDefault();
      e.stopPropagation();
      // Dispatched rather than .click(): the point may be on an icon's SVG,
      // which has no click() of its own; the event bubbles to its button.
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: frame.contentWindow }));
    };
    // Inside it, while it's taking input (same origin, so its window is ours
    // to listen to): leaving the areas hands input back to the slide.
    const inner = frame.contentWindow;
    const onInnerMove = (e: PointerEvent) => {
      setHot(inside(regions, e.clientX / frame.clientWidth, e.clientY / frame.clientHeight));
    };
    const onInnerLeave = () => setHot(false);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onTouchMove, true);
    window.addEventListener("pointerup", onTouchEnd, true);
    window.addEventListener("pointercancel", onTouchEnd, true);
    window.addEventListener("click", onClick, true);
    inner?.addEventListener("pointermove", onInnerMove);
    inner?.document.documentElement.addEventListener("pointerleave", onInnerLeave);
    return () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointermove", onTouchMove, true);
      window.removeEventListener("pointerup", onTouchEnd, true);
      window.removeEventListener("pointercancel", onTouchEnd, true);
      window.removeEventListener("click", onClick, true);
      inner?.removeEventListener("pointermove", onInnerMove);
      inner?.document.documentElement.removeEventListener("pointerleave", onInnerLeave);
    };
    // readyCount: the plugin's document replaces the frame's, so re-listen.
  }, [regions, readyCount]);

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
