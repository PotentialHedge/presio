// The lasso's geometry: the loop as an SVG path, and what dragging the
// selection's box does to it — moved when dragged inside, scaled about the
// opposite corner when dragged by one.

import type { Transform } from "./model";
import type { Bounds } from "./geometry";

/** An SVG path for the loop's points (page fractions, x, y, x, y, …). */
export function loopPath(loop: number[] | null): string {
  return loop && loop.length >= 2 ? `M${loop.map((n, i) => (i % 2 ? `${n}` : `${i ? "L" : ""}${n}`)).join(" ")}Z` : "";
}

export interface SelectionDrag {
  /** The corner dragged ("nw", …), or null for the box itself. */
  corner: string | null;
  /** Where the drag began (page fractions). */
  from: [number, number];
  /** The selection's bounds when it began. */
  box: Bounds;
}

/** The transform a drag to (x, y) makes; `page` is the page's size in CSS pixels. */
export function dragTransform(d: SelectionDrag, [x, y]: number[], page: { w: number; h: number }): Transform {
  if (!d.corner) return [1, x - d.from[0], y - d.from[1], 0, 0];
  // Scaled about the opposite corner, as far as the pointer is along the diagonal.
  const { minX, minY, maxX, maxY } = d.box;
  const ax = d.corner.includes("w") ? maxX : minX;
  const ay = d.corner.includes("n") ? maxY : minY;
  const cx = (d.corner.includes("w") ? minX : maxX) - ax;
  const cy = (d.corner.includes("n") ? minY : maxY) - ay;
  const px = (x - ax) * page.w;
  const py = (y - ay) * page.h;
  const len2 = (cx * page.w) ** 2 + (cy * page.h) ** 2 || 1;
  const k = Math.min(20, Math.max(0.1, (px * cx * page.w + py * cy * page.h) / len2));
  return [k, 0, 0, ax, ay];
}
