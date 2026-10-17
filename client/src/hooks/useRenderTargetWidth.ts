import { useEffect, useState } from "react";

// Ignore changes under this fraction of the current width. renderPage quantises
// scale anyway, so sub-percent deltas would re-render to the identical cached
// canvas and just churn the DOM during a drag-resize.
const MIN_CHANGE = 0.01;

/**
 * The width, in device pixels, that a slide canvas should be rendered at to
 * fill `container` crisply — its CSS width times the device pixel ratio.
 *
 * Recomputed when the container resizes (window resize, fullscreen, layout
 * change) and when the device pixel ratio changes (browser zoom, or dragging
 * the window to a differently-scaled monitor). Without this the canvas keeps
 * whatever resolution it was first rendered at and the browser upscales it,
 * which is what makes the slide look soft.
 *
 * Returns 0 until the container has been measured.
 */
export function useRenderTargetWidth(container: HTMLElement | null, enabled = true): number {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (!enabled || !container) return;

    let frame = 0;
    const measure = () => {
      // Coalesce bursts — a drag-resize fires continuously.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const dpr = window.devicePixelRatio || 1;
        const next = Math.round((container.clientWidth || 1280) * dpr);
        setWidth((prev) =>
          prev === 0 || Math.abs(next - prev) / prev > MIN_CHANGE ? next : prev
        );
      });
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(container);

    // devicePixelRatio fires no event of its own. This media query stops
    // matching the moment it changes; re-arm it against the new value each
    // time. Guarded because Safari only gained `resolution` support recently —
    // there the window resize that usually accompanies a DPR change covers us.
    let mq: MediaQueryList | null = null;
    const onDprChange = () => {
      measure();
      armDprWatch();
    };
    const armDprWatch = () => {
      mq?.removeEventListener("change", onDprChange);
      mq = null;
      try {
        mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
        mq.addEventListener("change", onDprChange);
      } catch {
        mq = null;
      }
    };
    armDprWatch();
    window.addEventListener("resize", measure);

    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      mq?.removeEventListener("change", onDprChange);
      window.removeEventListener("resize", measure);
    };
  }, [container, enabled]);

  return width;
}
