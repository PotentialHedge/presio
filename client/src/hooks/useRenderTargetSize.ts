import { useEffect, useState } from "react";

// While resizing, ignore changes under this fraction of the current size:
// sub-percent deltas would re-render the slide on nearly every frame of a
// drag. Once the size holds still for SETTLE_MS it's adopted exactly, so the
// slide never stays slightly upscaled after a small change.
const MIN_CHANGE = 0.01;
const SETTLE_MS = 150;

export interface RenderTargetSize {
  /** Device pixels; 0 until measured. */
  width: number;
  /** Device pixels; 0 when the container has no height of its own. */
  height: number;
}

const changed = (next: number, prev: number) =>
  prev === 0 ? next !== 0 : Math.abs(next - prev) / prev > MIN_CHANGE;

/**
 * The box, in device pixels, that a slide canvas should be rendered to fit so
 * it fills `container` crisply — its CSS size times the device pixel ratio.
 * Both dimensions, because a slide whose shape differs from the container's is
 * letterboxed: it shows at less than the container's width, and a canvas sized
 * to the width alone gets shrunk to fit, which softens the text.
 *
 * Recomputed when the container resizes (window resize, fullscreen, layout
 * change) and when the device pixel ratio changes (browser zoom, or dragging
 * the window to a differently-scaled monitor). Without this the canvas keeps
 * whatever resolution it was first rendered at and the browser upscales it,
 * which is what makes the slide look soft.
 *
 * Returns 0 until the container has been measured.
 */
export function useRenderTargetSize(container: HTMLElement | null, enabled = true): RenderTargetSize {
  const [size, setSize] = useState<RenderTargetSize>({ width: 0, height: 0 });

  useEffect(() => {
    if (!enabled || !container) return;

    let frame = 0;
    let settle = 0;
    const read = (): RenderTargetSize => {
      const dpr = window.devicePixelRatio || 1;
      return {
        width: Math.round((container.clientWidth || 1280) * dpr),
        height: Math.round(container.clientHeight * dpr),
      };
    };
    const measure = () => {
      // Coalesce bursts — a drag-resize fires continuously.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = read();
        setSize((prev) =>
          changed(next.width, prev.width) || changed(next.height, prev.height) ? next : prev
        );
      });
      clearTimeout(settle);
      settle = window.setTimeout(() => {
        const next = read();
        setSize((prev) => (next.width === prev.width && next.height === prev.height ? prev : next));
      }, SETTLE_MS);
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
      clearTimeout(settle);
      ro.disconnect();
      mq?.removeEventListener("change", onDprChange);
      window.removeEventListener("resize", measure);
    };
  }, [container, enabled]);

  return size;
}
