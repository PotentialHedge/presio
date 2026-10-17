import { useEffect, useRef } from "react";

// How far a finger may drift before a touch stops counting as a tap.
const MAX_TAP_SLOP_PX = 10;
// How long a touch may last before it stops counting as a tap (long presses
// are for the context menu / callout, not navigation).
const MAX_TAP_MS = 500;
// Where a plugin takes a pen's input and leaves fingers to the slide
// (setInteractive("pen"): a stylus drawing), a finger double-tap may be the
// plugin's: a tap waits this long for a second one, and two drop both.
const DOUBLE_TAP_MS = 350;
const PEN_INPUT = "[data-pen-input]";

// Taps that start on an interactive element (a control overlaid on the slide)
// belong to that control, never to navigation.
const INTERACTIVE_SELECTOR =
  "button, a, input, textarea, select, [role='button'], [contenteditable='true']";

interface TapNavOptions {
  enabled: boolean;
  onPrev: () => void;
  onNext: () => void;
}

// Make the current-slide surface behave like a slide on a touchscreen: a tap
// on the right half advances, a tap on the left half goes back.
//
// Touch pointers only, so mouse behaviour on desktop is unchanged. With
// `enabled` false (a drawing tool is active) taps never navigate, and a tap
// only fires when the finger stays roughly put and is released quickly — so
// strokes, scrolls and long presses are never mistaken for navigation. Also
// stops the browser from ever leaving the slide surface in a text-selected
// state (the stray selection seen on slow or long-press strokes).
export function useSlideTapNav(
  el: HTMLElement | null,
  options: TapNavOptions
) {
  // Latest options, read by the listeners; kept in a ref so the listeners are
  // bound once and always see current values without re-binding every render.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });
  const startRef = useRef<{ id: number; x: number; y: number; t: number } | null>(null);
  const pendingRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!el) return;

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      // A second finger: a pinch or a two-finger tap, not a tap to navigate.
      if (!e.isPrimary) {
        if (pendingRef.current !== null) clearTimeout(pendingRef.current);
        pendingRef.current = null;
        startRef.current = null;
        return;
      }
      const target = e.target;
      if (target instanceof Element && target.closest(INTERACTIVE_SELECTOR)) return;
      // A second touch while a tap waits: it was a double-tap.
      if (pendingRef.current !== null) {
        clearTimeout(pendingRef.current);
        pendingRef.current = null;
        startRef.current = null;
        return;
      }
      startRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now() };
    };

    const onPointerUp = (e: PointerEvent) => {
      const s = startRef.current;
      if (!s || s.id !== e.pointerId) return;
      startRef.current = null;
      const { enabled, onPrev, onNext } = optionsRef.current;
      if (!enabled) return;
      if (performance.now() - s.t > MAX_TAP_MS) return;
      if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > MAX_TAP_SLOP_PX) return;
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0) return;
      const go = e.clientX < rect.left + rect.width / 2 ? onPrev : onNext;
      // The plugin layers sit beside the slide, not in it.
      if (!document.querySelector(PEN_INPUT)) {
        go();
        return;
      }
      pendingRef.current = setTimeout(() => {
        pendingRef.current = null;
        go();
      }, DOUBLE_TAP_MS);
    };

    const onPointerCancel = () => {
      startRef.current = null;
    };

    const onSelectStart = (e: Event) => e.preventDefault();

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerCancel);
    el.addEventListener("selectstart", onSelectStart);
    return () => {
      if (pendingRef.current !== null) clearTimeout(pendingRef.current);
      pendingRef.current = null;
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerCancel);
      el.removeEventListener("selectstart", onSelectStart);
    };
  }, [el]);
}
