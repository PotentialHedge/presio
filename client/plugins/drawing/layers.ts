// The drawing's elements, stacked on the page: committed strokes on a canvas
// of their own; the stroke being drawn (a stable part and its tip, on
// low-latency canvases); the laser's trail and dot; the lasso's loop and
// selection box; and the eraser's ring.

import { icon } from "./icons";

const canvas = (lowLatency: boolean) => {
  const c = document.createElement("canvas");
  // A low-latency canvas for what's drawn under the pen: it can reach the
  // screen without waiting on the rest of the page.
  const ctx = c.getContext("2d", lowLatency ? { desynchronized: true } : undefined)!;
  return { c, ctx };
};

export type Layers = ReturnType<typeof createLayers>;

/** Builds the layers into `root`. Only the presenter's live canvases are low-latency. */
export function createLayers(root: HTMLElement, presenter: boolean) {
  const committed = canvas(false);
  const liveLayer = document.createElement("div");
  liveLayer.className = "live";
  const stable = canvas(presenter);
  const tip = canvas(presenter);
  liveLayer.append(stable.c, tip.c);
  const laserDot = document.createElement("div");
  laserDot.className = "laser";
  laserDot.dataset.testid = "laser-dot";
  laserDot.dataset.laser = presenter ? "local" : "remote";
  laserDot.hidden = true;
  const trailCanvas = document.createElement("canvas");
  trailCanvas.className = "laser-trail";
  const eraserRing = document.createElement("div");
  eraserRing.className = "eraser-ring";
  eraserRing.hidden = true;
  const lassoLoop = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  lassoLoop.classList.add("lasso-loop");
  lassoLoop.setAttribute("viewBox", "0 0 1 1");
  lassoLoop.setAttribute("preserveAspectRatio", "none");
  const lassoPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
  lassoLoop.append(lassoPath);
  const selectionEl = document.createElement("div");
  selectionEl.className = "selection";
  selectionEl.dataset.testid = "lasso-selection";
  // A finger moves it even when only the pen draws.
  selectionEl.dataset.control = "";
  selectionEl.hidden = true;
  for (const corner of ["nw", "ne", "sw", "se"]) {
    const h = document.createElement("div");
    h.className = `handle ${corner}`;
    h.dataset.corner = corner;
    selectionEl.append(h);
  }
  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "btn delete";
  deleteBtn.title = "Delete the selection";
  deleteBtn.dataset.testid = "lasso-delete";
  deleteBtn.innerHTML = icon("trash");
  selectionEl.append(deleteBtn);
  // The surface covers the whole slide area (the current slide card, a
  // viewer's screen), so the palette can sit anywhere on it; what's drawn
  // lives on the page within it, in page fractions.
  const pageEl = document.createElement("div");
  pageEl.className = "page";
  pageEl.append(committed.c, liveLayer, trailCanvas, lassoLoop, selectionEl, eraserRing, laserDot);
  root.append(pageEl);

  return { pageEl, committed, liveLayer, stable, tip, laserDot, trailCanvas, eraserRing, lassoPath, selectionEl, deleteBtn };
}
