// The presenter's slide zoom as the audience sees it (issue #172).
//
// The controller zooms its current-slide card with a pinch (useSlidePinchZoom),
// as a transform in that card's pixels. A viewer's slide is a different size
// and shape, so what travels is device-independent: how far in, and which
// point of the page is in the middle of the view. Each viewer turns that back
// into a transform of its own, centered on the same point as far as its edges
// allow, at the same scale relative to "page fits the screen".

import type { Rect } from "@/lib/containedRect";
import type { SlideZoom } from "@/hooks/useSlidePinchZoom";

export interface AudienceZoom {
  /** 1 = the whole page, as it fits. */
  scale: number;
  /** The point of the page in the middle of the view, as fractions of it. */
  cx: number;
  cy: number;
}

export const NO_ZOOM: AudienceZoom = { scale: 1, cx: 0.5, cy: 0.5 };

/** Same limit as the controller's pinch. */
export const MAX_AUDIENCE_ZOOM = 4;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Whether `z` is a well-formed zoom (it comes off the wire). */
export function isAudienceZoom(z: unknown): z is AudienceZoom {
  if (typeof z !== "object" || z === null) return false;
  const { scale, cx, cy } = z as Record<string, unknown>;
  return (
    typeof scale === "number" && Number.isFinite(scale) && scale >= 1 && scale <= MAX_AUDIENCE_ZOOM &&
    typeof cx === "number" && Number.isFinite(cx) && cx >= 0 && cx <= 1 &&
    typeof cy === "number" && Number.isFinite(cy) && cy >= 0 && cy <= 1
  );
}

export function sameAudienceZoom(a: AudienceZoom, b: AudienceZoom): boolean {
  if (a.scale <= 1 && b.scale <= 1) return true;
  return Math.abs(a.scale - b.scale) < 1e-3 && Math.abs(a.cx - b.cx) < 1e-4 && Math.abs(a.cy - b.cy) < 1e-4;
}

/** The controller's zoom of a `container`-sized surface showing the page at `page`. */
export function toAudienceZoom(zoom: SlideZoom, container: { width: number; height: number }, page: Rect): AudienceZoom {
  if (zoom.scale <= 1 || page.width <= 0 || page.height <= 0) return NO_ZOOM;
  const midX = (container.width / 2 - zoom.x) / zoom.scale;
  const midY = (container.height / 2 - zoom.y) / zoom.scale;
  return {
    scale: clamp(zoom.scale, 1, MAX_AUDIENCE_ZOOM),
    cx: clamp((midX - page.left) / page.width, 0, 1),
    cy: clamp((midY - page.top) / page.height, 0, 1),
  };
}

/** `zoom` as a transform of a `container`-sized surface showing the page at
 *  `page`: the same kind useSlidePinchZoom produces (origin top-left), kept
 *  covering the surface. */
export function fromAudienceZoom(zoom: AudienceZoom, container: { width: number; height: number }, page: Rect): SlideZoom {
  const { width: w, height: h } = container;
  if (zoom.scale <= 1 || w <= 0 || h <= 0 || page.width <= 0) return { scale: 1, x: 0, y: 0 };
  const s = zoom.scale;
  const px = page.left + zoom.cx * page.width;
  const py = page.top + zoom.cy * page.height;
  return {
    scale: s,
    x: clamp(w / 2 - s * px, w * (1 - s), 0),
    y: clamp(h / 2 - s * py, h * (1 - s), 0),
  };
}
