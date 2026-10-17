import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

const MIN_SCALE = 1;
const MAX_SCALE = 4;
// Two taps within this window (and distance) reset the zoom.
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_PX = 24;

export interface SlideZoom {
  scale: number;
  /** Translate in surface pixels; the transform origin is the top-left corner. */
  x: number;
  y: number;
}

const IDENTITY: SlideZoom = { scale: 1, x: 0, y: 0 };

interface PinchZoomOptions {
  /** Reports whether a gesture is in progress or the slide is zoomed. */
  onActiveChange?: (active: boolean) => void;
}

// Pinch-to-zoom and pan for the current-slide surface, built on pointer events
// so it behaves the same on iOS and Android touch screens. Two fingers pinch
// around their midpoint, a single finger pans while zoomed, and a double-tap
// returns to fit-to-card. The transform is purely local to this device —
// nothing is emitted to viewers or other sessions.
//
// Where a plugin's slide layer takes input (a drawing tool), single-finger
// input is the plugin's and never gets here; SlideLayers passes touches on
// once a second finger comes down, so two fingers still pinch and pan.
//
// The caller applies `zoom` as a CSS transform on a wrapper around everything
// that should move with the slide content.
export function useSlidePinchZoom(
  ref: RefObject<HTMLElement | null>,
  { onActiveChange }: PinchZoomOptions
) {
  const [zoom, setZoom] = useState<SlideZoom>(IDENTITY);
  // Latest values for the listeners; kept in refs so they are bound once and
  // always see current state without re-binding every render.
  const zoomRef = useRef(zoom);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinchBase = useRef<{ dist: number; midX: number; midY: number; zoom: SlideZoom } | null>(null);
  const panLast = useRef<{ x: number; y: number } | null>(null);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const [gesturing, setGesturing] = useState(false);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  // Keep the scaled content covering the surface: at origin 0 0 the content
  // spans [x, x + scale*size], which must include [0, size].
  const clampToSurface = useCallback(
    (next: SlideZoom): SlideZoom => {
      const el = ref.current;
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next.scale));
      if (!el || scale <= MIN_SCALE) return IDENTITY;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w <= 0 || h <= 0) return IDENTITY;
      return {
        scale,
        x: Math.min(0, Math.max(w * (1 - scale), next.x)),
        y: Math.min(0, Math.max(h * (1 - scale), next.y)),
      };
    },
    [ref]
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const tracked = pointers.current;

    // Capturing on the surface retargets the pointer away from whatever it
    // started on, so it only happens once this hook actually owns the gesture.
    // (Touches handed on from a plugin's frame can't be captured here; they
    // keep arriving from the frame regardless.)
    const capture = (pointerId: number) => {
      try {
        el.setPointerCapture(pointerId);
      } catch {
        // The pointer may already be gone; nothing to take over.
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      tracked.set(e.pointerId, { x: e.clientX, y: e.clientY });
      setGesturing(tracked.size >= 2);
      if (tracked.size === 2) {
        const [a, b] = [...tracked.values()];
        pinchBase.current = {
          dist: Math.hypot(a.x - b.x, a.y - b.y),
          midX: (a.x + b.x) / 2,
          midY: (a.y + b.y) / 2,
          zoom: zoomRef.current,
        };
        panLast.current = null;
        lastTap.current = null;
        for (const id of tracked.keys()) capture(id);
      } else if (tracked.size === 1 && zoomRef.current.scale > 1) {
        panLast.current = { x: e.clientX, y: e.clientY };
        capture(e.pointerId);
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!tracked.has(e.pointerId)) return;
      tracked.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const base = pinchBase.current;
      if (tracked.size >= 2 && base) {
        if (base.dist <= 0) return;
        const [a, b] = [...tracked.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        const scale = base.zoom.scale * (dist / base.dist);
        // Keep the content point that sat under the initial midpoint under
        // the current midpoint as the pinch grows and drifts.
        const cx = (base.midX - base.zoom.x) / base.zoom.scale;
        const cy = (base.midY - base.zoom.y) / base.zoom.scale;
        setZoom(clampToSurface({ scale, x: midX - cx * scale, y: midY - cy * scale }));
        return;
      }
      const last = panLast.current;
      if (tracked.size === 1 && last && zoomRef.current.scale > 1) {
        const z = zoomRef.current;
        setZoom(clampToSurface({ ...z, x: z.x + (e.clientX - last.x), y: z.y + (e.clientY - last.y) }));
        panLast.current = { x: e.clientX, y: e.clientY };
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!tracked.delete(e.pointerId)) return;
      const wasPinching = !!pinchBase.current;
      setGesturing(tracked.size >= 2);
      if (tracked.size < 2) pinchBase.current = null;
      if (tracked.size === 1) {
        // The remaining finger takes over panning from where it sits now.
        const [p] = [...tracked.values()];
        panLast.current = { x: p.x, y: p.y };
      } else {
        panLast.current = null;
      }
      // Double-tap resets — but only while zoomed, so taps keep reaching
      // slide navigation untouched.
      if (zoomRef.current.scale > 1 && !wasPinching) {
        const now = performance.now();
        const prev = lastTap.current;
        if (
          prev &&
          now - prev.t <= DOUBLE_TAP_MS &&
          Math.hypot(e.clientX - prev.x, e.clientY - prev.y) <= DOUBLE_TAP_SLOP_PX
        ) {
          setZoom(IDENTITY);
          panLast.current = null;
          lastTap.current = null;
          return;
        }
        lastTap.current = { t: now, x: e.clientX, y: e.clientY };
      } else {
        lastTap.current = null;
      }
    };

    const onPointerCancel = (e: PointerEvent) => {
      tracked.delete(e.pointerId);
      setGesturing(tracked.size >= 2);
      pinchBase.current = null;
      panLast.current = null;
      lastTap.current = null;
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerCancel);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerCancel);
      tracked.clear();
      pinchBase.current = null;
      panLast.current = null;
      lastTap.current = null;
    };
  }, [ref, clampToSurface]);

  const active = gesturing || zoom.scale > 1;
  useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);

  const reset = useCallback(() => setZoom(IDENTITY), []);

  return { zoom, gesturing, reset };
}
