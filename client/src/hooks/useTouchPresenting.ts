import { useEffect } from "react";

type FullscreenDoc = Document & { webkitFullscreenElement?: Element | null };
type FullscreenEl = HTMLElement & { webkitRequestFullscreen?: () => void };

const fullscreenElement = () =>
  document.fullscreenElement ?? (document as FullscreenDoc).webkitFullscreenElement ?? null;

// The controller on a touch screen (an iPad) is an instrument, not a page:
//
//  - It goes fullscreen at the first touch, and again at the next one after
//    leaving it (browsers only allow it in answer to a gesture). Installed to
//    the home screen it already is.
//  - The page never zooms — not by a pinch, not by a double-tap. Only the
//    current slide does (useSlidePinchZoom), on its own.
export function useTouchPresenting() {
  useEffect(() => {
    if (!matchMedia("(pointer: coarse)").matches) return;
    const root = document.documentElement as FullscreenEl;
    const standalone = matchMedia("(display-mode: standalone), (display-mode: fullscreen)").matches;
    const canFullscreen = !standalone && (document.fullscreenEnabled || !!root.webkitRequestFullscreen);

    const enter = () => {
      if (!canFullscreen || fullscreenElement()) return;
      try {
        if (root.requestFullscreen) void root.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
        else root.webkitRequestFullscreen?.();
      } catch {
        // Refused (no gesture after all, or not allowed here): the next touch tries again.
      }
    };
    // Safari's own pinch-to-zoom of the page.
    const noZoom = (e: Event) => e.preventDefault();
    const touchAction = document.body.style.touchAction;
    document.body.style.touchAction = "pan-x pan-y";

    // Whichever of these the browser counts as the gesture.
    const gestures = ["pointerup", "touchend", "click"] as const;
    for (const type of gestures) window.addEventListener(type, enter, true);
    document.addEventListener("gesturestart", noZoom);
    document.addEventListener("gesturechange", noZoom);
    return () => {
      for (const type of gestures) window.removeEventListener(type, enter, true);
      document.removeEventListener("gesturestart", noZoom);
      document.removeEventListener("gesturechange", noZoom);
      document.body.style.touchAction = touchAction;
    };
  }, []);
}
