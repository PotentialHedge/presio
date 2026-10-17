import { useEffect } from "react";

// Two taps closer together than this would be Safari's double-tap zoom.
const DOUBLE_TAP_MS = 350;
const CONTROL = "button, a, [role='button'], label";
const FIELD = "input, textarea, select, [contenteditable='true']";

// The controller on a touch screen (an iPad) is an instrument, not a page: it
// never zooms — not by a pinch, not by a double-tap. Only the current slide
// does (useSlidePinchZoom), on its own.
//
//  - touch-action: manipulation on everything (.no-page-zoom, index.css; the
//    plugin frames set their own) turns double-tap zoom off where Safari
//    honours it;
//  - where it doesn't, the second tap's touchend is cancelled, which is what
//    would zoom — and the click that cancelling costs is made by hand;
//  - Safari's gesture events, the pinch, are cancelled.
//
// (Not fullscreen: Safari warns about typing while in fullscreen as a
// possible phishing page. Added to the home screen, it's fullscreen anyway.)
export function useTouchPresenting() {
  useEffect(() => {
    if (!matchMedia("(pointer: coarse)").matches) return;
    const root = document.documentElement;
    root.classList.add("no-page-zoom");

    let lastEnd = -Infinity;
    const onTouchEnd = (e: TouchEvent) => {
      const now = performance.now();
      const quick = now - lastEnd < DOUBLE_TAP_MS;
      lastEnd = now;
      if (!quick || e.touches.length > 0 || e.changedTouches.length !== 1) return;
      const target = e.target as Element | null;
      if (!target?.closest || target.closest(FIELD)) return;
      e.preventDefault();
      (target.closest(CONTROL) as HTMLElement | null)?.click();
    };
    const noZoom = (e: Event) => e.preventDefault();
    document.addEventListener("touchend", onTouchEnd, { passive: false });
    document.addEventListener("gesturestart", noZoom);
    document.addEventListener("gesturechange", noZoom);
    return () => {
      root.classList.remove("no-page-zoom");
      document.removeEventListener("touchend", onTouchEnd);
      document.removeEventListener("gesturestart", noZoom);
      document.removeEventListener("gesturechange", noZoom);
    };
  }, []);
}
