import { useEffect } from "react";

// The controller on a touch screen (an iPad) is an instrument, not a page: it
// never zooms — not by a pinch, not by a double-tap. Only the current slide
// does (useSlidePinchZoom), on its own.
//
// (Not fullscreen: Safari warns about typing while in fullscreen as a
// possible phishing page. Added to the home screen, it's fullscreen anyway.)
export function useTouchPresenting() {
  useEffect(() => {
    if (!matchMedia("(pointer: coarse)").matches) return;
    // Safari's own pinch-to-zoom of the page.
    const noZoom = (e: Event) => e.preventDefault();
    const touchAction = document.body.style.touchAction;
    document.body.style.touchAction = "pan-x pan-y";
    document.addEventListener("gesturestart", noZoom);
    document.addEventListener("gesturechange", noZoom);
    return () => {
      document.removeEventListener("gesturestart", noZoom);
      document.removeEventListener("gesturechange", noZoom);
      document.body.style.touchAction = touchAction;
    };
  }, []);
}
