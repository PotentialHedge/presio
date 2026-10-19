// How a plugin's live "slide" surface (SlideSurface in SlideLayers.tsx) shares
// pointer input with the slide under it.

import { useEffect, useRef } from "react";

export type Region = { x: number; y: number; w: number; h: number };

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

/** "pen" mode: touches this soon after the pen lifts are still the hand. */
const PALM_QUIET_MS = 250;
/** "pen" mode: what in a plugin's frame a finger works, rather than the slide. */
const PLUGIN_CONTROL = "button, a, input, select, textarea, [role='button'], [data-control]";
/** "pen" mode: a finger's tap, forwarded as a click to a link on the slide. */
const TAP_MS = 500;
const TAP_SLOP_PX = 10;

/**
 * Whether a mouse is over the page (presio.ui.onHover): over the frame when it
 * takes input, over what's under it when it doesn't. The presenter's only —
 * it's for their own controls.
 */
export function useFrameHover(
  frameRef: React.RefObject<HTMLIFrameElement | null>,
  enabled: boolean,
  readyCount: number,
  setHovered: (hovered: boolean) => void,
) {
  useEffect(() => {
    const frame = frameRef.current;
    if (!enabled || !frame) return;
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
  }, [frameRef, enabled, readyCount, setHovered]);
}

/**
 * Touches the frame took, passed on to the page once two are down: the
 * pinch-zoom (useSlidePinchZoom) listens above the frame, where input that
 * lands inside it never arrives. One finger stays the plugin's — except in
 * "pen" mode, where every finger is passed on from the start (to pan, pinch
 * and turn the page) and only a pen's input is the plugin's. There, a touch
 * while the pen is down, or just after, is a hand resting on the screen:
 * it's never passed on, and a pen landing ends what fingers had begun.
 */
export function useTouchHandoff(
  frameRef: React.RefObject<HTMLIFrameElement | null>,
  enabled: boolean,
  readyCount: number,
  penOnly: boolean,
) {
  const penOnlyRef = useRef(penOnly);
  useEffect(() => {
    penOnlyRef.current = penOnly;
  }, [penOnly]);
  useEffect(() => {
    const frame = frameRef.current;
    const inner = frame?.contentWindow;
    if (!enabled || !frame || !inner) return;
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
  }, [frameRef, enabled, readyCount]);
}

/**
 * A plugin that takes input only in some areas (presio.ui.setInteractive with
 * regions): a mouse makes the frame take input while it hovers one (`setHot`);
 * a touch on one is forwarded into the frame, and a tap arrives as a click.
 */
export function useInteractiveRegions(
  frameRef: React.RefObject<HTMLIFrameElement | null>,
  regions: Region[] | null,
  readyCount: number,
  setHot: (hot: boolean) => void,
) {
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
  }, [frameRef, regions, readyCount, setHot]);
}
