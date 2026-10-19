import { useState, useEffect } from "react";
import { getSetting, setSetting } from "@/lib/settings";
import { useMediaQuery } from "./useMediaQuery";

// Hidden escape hatch: loading any page with ?desktop=1 forces the desktop
// layout on a phone/tablet; ?desktop=0 goes back to the responsive default.
// The choice sticks as the "layout.forceDesktop" setting, so it survives
// navigation.
// Evaluated once per page load — the param arrives via a full load anyway.
function readForceDesktop(): boolean {
  const param = new URLSearchParams(window.location.search).get("desktop");
  if (param !== null) {
    const on = param !== "0" && param !== "false";
    setSetting("layout.forceDesktop", on);
    return on;
  }
  return getSetting("layout.forceDesktop");
}
const forceDesktop = readForceDesktop();

export function useIsMobile(breakpoint = 768) {
  return useMediaQuery(`(max-width: ${breakpoint}px)`) && !forceDesktop;
}

// A phone held sideways has room across but almost none down, so the
// controller's card layout can't be the same as in portrait. Orientation
// rather than a width breakpoint, because that is the thing that changes.
export function useIsLandscape(): boolean {
  return useMediaQuery("(orientation: landscape)");
}

// Touch-device detection for the first-visit prompts. Width alone misses
// tablets: an iPad in landscape is 1024px wide (1366px on a Pro), well past
// the 768px mobile breakpoint. The primary pointer being coarse (finger/stylus)
// is the reliable signal that the screen is touch-first, holds in any
// orientation, and stays false on desktop touch-laptops whose primary input is
// a mouse/trackpad. Respects the same ?desktop=1 override as useIsMobile.
export function isTouchDevice(): boolean {
  if (forceDesktop) return false;
  return window.matchMedia("(pointer: coarse)").matches;
}

export function useIsTouchDevice(): boolean {
  const [isTouch, setIsTouch] = useState(isTouchDevice);

  useEffect(() => {
    const mq = window.matchMedia("(pointer: coarse)");
    const onChange = () => setIsTouch(isTouchDevice());
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return isTouch;
}
