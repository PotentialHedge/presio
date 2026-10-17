// The drawing on the slide itself: on the presenter's current slide, where
// they draw (and carry the palette), and on every viewer, where it's followed.
//
// Three layers: committed strokes on a canvas of their own, only redrawn when
// they change (and then only the new ones, when strokes were just added); the
// stroke being drawn, painted a segment at a time (LiveStroke); the laser, a
// dot moved by transform. Input is read in full — every coalesced pointer
// sample, plus the predicted ones for the tip — painted once a frame, and the
// new points go out once a frame too, so nothing waits on a throttle and the
// tail of a stroke is never dropped.

import {
  addOps,
  canRedo,
  canUndo,
  clearOps,
  commitAll,
  decodePoints,
  encodePoints,
  eraseOps,
  forgetDecoded,
  MAX_STROKE_POINTS,
  moveOps,
  newGroup,
  newId,
  opacityOf,
  openDrawing,
  parseBegin,
  redoOps,
  strokes as strokesOf,
  transformStroke,
  undoOps,
  type Stroke,
  type Tool,
  type Transform,
} from "./model";
import { drawStrokes, LiveStroke } from "./render";
import { Palette, type LaserStyle, type PenStyle } from "./palette";
import { lassoContains, strokeHit, strokesBounds, type Bounds } from "./geometry";
import { snapShape } from "./snap";
import { LaserTrail } from "./trail";
import { watchTaps } from "./taps";
import { icon } from "./icons";

// How long a viewer keeps showing a laser dot that stopped moving (covers a
// lost "hide").
const LASER_HIDE_MS = 3000;
// Points closer than this (CSS pixels of the page) to the last one add nothing.
const MIN_POINT_PX = 0.75;
// The furthest the stroke's tip reaches ahead of the pen, to where it's
// predicted to be next (CSS pixels).
const PREDICT_MAX_PX = 8;
// The canvases' resolution follows the zoom, up to this many pixels across.
const MAX_CANVAS_PX = 4096;
// Holding the pen still this long at the end of a stroke snaps it to a line
// or a box (advanced tools), and moving less than this doesn't count.
const SNAP_HOLD_MS = 500;
const SNAP_HOLD_SLOP_PX = 4;
// The eraser's reach (CSS pixels).
const ERASER_RADIUS_PX = 10;

const TOOLS: Tool[] = ["none", "laser", "pen", "highlighter", "eraser", "lasso"];
const isTool = (t: unknown): t is Tool => TOOLS.includes(t as Tool);
const laserSizeOf = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(48, Math.max(4, v)) : 16);

interface Draft {
  stroke: Stroke;
  slide: number;
  live: LiveStroke;
  /** Points already sent (presenter). */
  sent: number;
}

export function runSlide() {
  const presenter = presio.role === "presenter";
  const root = document.getElementById("root")!;
  const history = openDrawing();
  let slide = presio.slide.current;

  // --- Layers ---

  const canvas = (fast: boolean) => {
    const c = document.createElement("canvas");
    // A low-latency canvas for what's drawn under the pen: it can reach the
    // screen without waiting on the rest of the page.
    const ctx = c.getContext("2d", fast && presenter ? { desynchronized: true } : undefined)!;
    return { c, ctx };
  };
  const committed = canvas(false);
  const liveLayer = document.createElement("div");
  liveLayer.className = "live";
  const stable = canvas(true);
  const tip = canvas(true);
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
  // A finger moves it even in pencil mode.
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

  // The page's box in the surface, in CSS pixels.
  let page = { x: 0, y: 0, w: 1, h: 1 };
  const placePage = () => {
    const p = presio.ui.page ?? { x: 0, y: 0, w: 1, h: 1 };
    page = { x: p.x * innerWidth, y: p.y * innerHeight, w: Math.max(1, p.w * innerWidth), h: Math.max(1, p.h * innerHeight) };
    Object.assign(pageEl.style, { left: `${page.x}px`, top: `${page.y}px`, width: `${page.w}px`, height: `${page.h}px` });
  };
  const onPage = (e: PointerEvent) =>
    e.clientX >= page.x && e.clientX <= page.x + page.w && e.clientY >= page.y && e.clientY <= page.y + page.h;

  let W = 0;
  let H = 0;
  let resolution = 1;
  const resize = () => {
    placePage();
    const dpr = window.devicePixelRatio || 1;
    const scale = Math.max(1, presio.ui.view?.scale ?? 1);
    resolution = Math.min(dpr * scale, MAX_CANVAS_PX / page.w);
    const w = Math.max(1, Math.round(page.w * resolution));
    const h = Math.max(1, Math.round(page.h * resolution));
    if (w === W && h === H) return;
    W = w;
    H = h;
    for (const { c } of [committed, stable, tip]) {
      c.width = W;
      c.height = H;
    }
    drawn = null;
    redrawCommitted();
    if (draft) {
      draft.live.reset();
      schedule();
    }
  };

  // --- Committed strokes ---

  // What's on the committed canvas now, so adding strokes draws only those;
  // null when it has to be drawn afresh.
  let drawn: Stroke[] | null = null;
  // The lasso's selection while it's dragged: drawn moved, not yet committed.
  let preview: { ids: Set<string>; m: Transform } | null = null;
  const redrawCommitted = () => {
    const strokes = strokesOf(history.state, slide);
    if (preview) {
      const { ids, m } = preview;
      committed.ctx.clearRect(0, 0, W, H);
      drawStrokes(committed.ctx, strokes.map((s) => (ids.has(s.id) ? transformStroke(s, m) : s)), W, H);
      drawn = null;
      return;
    }
    const prev = drawn;
    const extends_ = !!prev && prev.length <= strokes.length && prev.every((s, i) => strokes[i] === s);
    if (!extends_) committed.ctx.clearRect(0, 0, W, H);
    drawStrokes(committed.ctx, extends_ ? strokes.slice(prev!.length) : strokes, W, H);
    drawn = strokes;
    // A stroke being drawn that has now arrived committed is done.
    if (draft && strokes.some((s) => s.id === draft!.stroke.id)) endDraft();
    placeSelection();
    renderPalette();
  };

  // The palette's undo and clear follow the drawing; it's redrawn only when
  // they change, so a change elsewhere never closes a menu that's open.
  let actionsKey = "";
  const renderPalette = (force = false) => {
    if (!palette) return;
    const key = `${canUndo(history, slide)}${canRedo(history, slide)}${strokesOf(history.state, slide).length > 0}`;
    if (!force && key === actionsKey) return;
    actionsKey = key;
    palette.render();
  };

  // --- The stroke being drawn ---

  let draft: Draft | null = null;
  const beginDraft = (stroke: Stroke, onSlide: number) => {
    if (draft) endDraft();
    draft = { stroke, slide: onSlide, live: new LiveStroke(stroke, stable.ctx, tip.ctx), sent: 0 };
    liveLayer.style.opacity = String(opacityOf(stroke));
    schedule();
  };
  const endDraft = () => {
    draft = null;
    predicted = [];
    stable.ctx.clearRect(0, 0, W, H);
    tip.ctx.clearRect(0, 0, W, H);
  };

  // --- One frame's work ---

  let queued = false;
  let predicted: number[] = [];
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(frame);
  };
  const frame = () => {
    queued = false;
    if (draft && draft.slide === slide) draft.live.paint(W, H, predicted);
    if (presenter) {
      sendPoints();
      sendLaser();
    } else if (moveRemoteLaser()) schedule();
  };

  // --- Presenter: drawing ---

  let tool: Tool = "none";
  const styleOf = (t: "pen" | "highlighter"): PenStyle => ({
    color: String(presio.settings.get(`${t}Color`) ?? (t === "pen" ? "#e11d48" : "#facc15")),
    size: Number(presio.settings.get(`${t}Size`) ?? (t === "pen" ? 3 : 14)),
  });
  // Touches down on the frame: a second one is a pinch (Presio's), which
  // abandons whatever the first began.
  const touches = new Set<number>();
  let pinching = false;

  const toPage = (e: PointerEvent) => [
    Math.min(1, Math.max(0, (e.clientX - page.x) / page.w)),
    Math.min(1, Math.max(0, (e.clientY - page.y) / page.h)),
  ];

  const addPoint = (e: PointerEvent) => {
    if (!draft) return;
    const p = draft.stroke.points;
    const [x, y] = toPage(e);
    const n = p.length;
    if (n && Math.hypot((x - p[n - 2]) * page.w, (y - p[n - 1]) * page.h) < MIN_POINT_PX) return;
    p.push(x, y);
    // Past what one message holds: finish this one and carry on in a new one
    // from the same spot, so the line is unbroken.
    if (p.length >= MAX_STROKE_POINTS * 2) {
      const { tool: t, color, width } = draft.stroke;
      finishStroke();
      startStroke({ id: newId(), tool: t, color, width, points: [x, y] });
    }
  };

  // Where the pen is about to be (getPredictedEvents), for the tip to reach
  // ahead to. A prediction is a guess, and a bad one on a quick turn shows as
  // a spike for a frame: it's used only when it carries on the way the pen is
  // already going, and never further than the pen's last step.
  const predict = (e: PointerEvent): number[] => {
    const p = draft?.stroke.points;
    const ahead = e.getPredictedEvents?.() ?? [];
    if (!p || p.length < 4 || !ahead.length) return [];
    const n = p.length;
    const [x, y] = toPage(ahead[ahead.length - 1]);
    const lx = (p[n - 2] - p[n - 4]) * page.w;
    const ly = (p[n - 1] - p[n - 3]) * page.h;
    const dx = (x - p[n - 2]) * page.w;
    const dy = (y - p[n - 1]) * page.h;
    const last = Math.hypot(lx, ly);
    const reach = Math.hypot(dx, dy);
    if (!last || !reach || (lx * dx + ly * dy) / (last * reach) < 0.9) return [];
    const k = Math.min(1, last / reach, PREDICT_MAX_PX / reach);
    return [p[n - 2] + (dx * k) / page.w, p[n - 1] + (dy * k) / page.h];
  };

  const startStroke = (stroke: Stroke) => {
    beginDraft(stroke, slide);
    draft!.sent = stroke.points.length;
    presio.messages.send("b", {
      i: stroke.id,
      s: slide,
      t: stroke.tool === "highlighter" ? "h" : "p",
      c: stroke.color,
      w: stroke.width,
      d: encodePoints(stroke.points),
    });
  };

  const sendPoints = () => {
    if (!draft || draft.sent >= draft.stroke.points.length) return;
    presio.messages.send("p", { i: draft.stroke.id, d: encodePoints(draft.stroke.points, draft.sent) });
    draft.sent = draft.stroke.points.length;
  };

  const finishStroke = () => {
    if (!draft) return;
    sendPoints();
    const { stroke, slide: on } = draft;
    endDraft();
    commitAll(history, addOps(on, stroke));
  };

  const abandonStroke = () => {
    if (!draft) return;
    presio.messages.send("x", { i: draft.stroke.id });
    endDraft();
  };

  // --- Laser ---
  //
  // A dot that follows the pointer (a mouse's even hovering), or a fading
  // line drawn while pressed. "l" carries { x, y, s: size, t: 1 for the line }.

  const laserStyle = (): LaserStyle => {
    return { size: laserSizeOf(presio.settings.get("laserSize")), trail: presio.settings.get("laserTrail") === true };
  };
  const trail = new LaserTrail(trailCanvas, () => ({ w: page.w, h: page.h, resolution: window.devicePixelRatio || 1 }));
  let laser: { x: number; y: number } | null = null;
  let laserSent: { x: number; y: number } | null = null;
  let laserSize = 16;
  // Whether the presenter's laser is drawing a line now, rather than the dot.
  let laserLine = false;
  const sizeDot = (size: number) => {
    const d = Math.max(6, (size / 960) * page.w);
    Object.assign(laserDot.style, { width: `${d}px`, height: `${d}px`, margin: `${-d / 2}px 0 0 ${-d / 2}px` });
  };
  const showLaser = (x: number, y: number) => {
    laserDot.hidden = false;
    laserDot.style.transform = `translate(${x * page.w}px, ${y * page.h}px)`;
  };
  const sendLaser = () => {
    if (!laser || (laserSent && laserSent.x === laser.x && laserSent.y === laser.y)) return;
    laserSent = laser;
    const { size } = laserStyle();
    presio.messages.send("l", { x: Math.round(laser.x * 1e4) / 1e4, y: Math.round(laser.y * 1e4) / 1e4, s: size, ...(laserLine && { t: 1 }) }, { volatile: true });
  };
  const hideLaser = () => {
    laserDot.hidden = true;
    if (presenter && (laser || laserSent)) presio.messages.send("l", null);
    if (laser) trail.push(null);
    laser = null;
    laserSent = null;
  };
  // The presenter's laser at (x, y): the dot, or the line.
  const moveLaser = (x: number, y: number, line: boolean) => {
    if (laserLine !== line && laser) {
      if (laserLine) trail.push(null);
      laserSent = null;
    }
    laserLine = line;
    laser = { x, y };
    const { size } = laserStyle();
    if (line) {
      laserDot.hidden = true;
      trail.push({ x, y, size });
    } else {
      sizeDot(size);
      showLaser(x, y);
    }
    schedule();
  };

  // A viewer's dot glides from where it is to each new position over about
  // the time between updates, so a 60 Hz stream reads as motion, not steps.
  let remoteLaser: { fx: number; fy: number; tx: number; ty: number; t0: number; dur: number; at: number } | null = null;
  let laserHideTimer: ReturnType<typeof setTimeout> | null = null;
  const moveRemoteLaser = () => {
    if (!remoteLaser) return false;
    const k = Math.min(1, (performance.now() - remoteLaser.t0) / remoteLaser.dur);
    showLaser(remoteLaser.fx + (remoteLaser.tx - remoteLaser.fx) * k, remoteLaser.fy + (remoteLaser.ty - remoteLaser.fy) * k);
    return k < 1;
  };
  let remoteTrail = false;
  const onRemoteLaser = (payload: unknown) => {
    if (laserHideTimer) clearTimeout(laserHideTimer);
    const p = payload as { x?: unknown; y?: unknown; s?: unknown; t?: unknown } | null;
    if (!p || typeof p.x !== "number" || typeof p.y !== "number") {
      remoteLaser = null;
      laserDot.hidden = true;
      if (remoteTrail) trail.push(null);
      remoteTrail = false;
      return;
    }
    const size = laserSizeOf(p.s);
    if (p.t === 1) {
      remoteLaser = null;
      laserDot.hidden = true;
      remoteTrail = true;
      trail.push({ x: p.x, y: p.y, size });
      return;
    }
    if (remoteTrail) trail.push(null);
    remoteTrail = false;
    if (size !== laserSize) sizeDot((laserSize = size));
    const now = performance.now();
    const prev = remoteLaser;
    const k = prev ? Math.min(1, (now - prev.t0) / prev.dur) : 1;
    const fx = prev && !laserDot.hidden ? prev.fx + (prev.tx - prev.fx) * k : p.x;
    const fy = prev && !laserDot.hidden ? prev.fy + (prev.ty - prev.fy) * k : p.y;
    const dur = prev ? Math.min(60, Math.max(8, now - prev.at)) : 16;
    remoteLaser = { fx, fy, tx: p.x, ty: p.y, t0: now, dur, at: now };
    laserHideTimer = setTimeout(() => {
      remoteLaser = null;
      laserDot.hidden = true;
    }, LASER_HIDE_MS);
    schedule();
  };

  // --- Presenter: the eraser ---

  // One drag erases as one change (one undo).
  let erasing: { group: string; hit: Set<string> } | null = null;
  const eraseAt = (e: PointerEvent) => {
    if (!erasing) return;
    const [x, y] = toPage(e);
    const ids = strokesOf(history.state, slide)
      .filter((st) => !erasing!.hit.has(st.id) && strokeHit(st, x, y, ERASER_RADIUS_PX, page.w, page.h))
      .map((st) => st.id);
    if (!ids.length) return;
    for (const id of ids) erasing.hit.add(id);
    commitAll(history, eraseOps(slide, ids, erasing.group));
  };
  const showRing = (e: PointerEvent | null) => {
    eraserRing.hidden = !e || tool !== "eraser";
    if (!e || eraserRing.hidden) return;
    const d = ERASER_RADIUS_PX * 2;
    Object.assign(eraserRing.style, {
      width: `${d}px`,
      height: `${d}px`,
      transform: `translate(${e.clientX - page.x - d / 2}px, ${e.clientY - page.y - d / 2}px)`,
    });
  };

  // --- Presenter: the lasso ---
  //
  // Drawing a loop selects the strokes mostly inside it; the selection's box
  // then moves them (dragged inside), scales them (by a corner) or deletes
  // them. A move shows here as it's dragged and is committed once, on release.

  let loop: number[] | null = null;
  let selected: Set<string> | null = null;
  let dragging: { corner: string | null; from: [number, number]; box: Bounds } | null = null;
  const selectedStrokes = () => strokesOf(history.state, slide).filter((st) => selected!.has(st.id));
  function placeSelection() {
    if (!selected || tool !== "lasso") {
      selectionEl.hidden = true;
      return;
    }
    let list = selectedStrokes();
    if (!list.length) {
      selected = null;
      selectionEl.hidden = true;
      return;
    }
    if (preview) list = list.map((st) => transformStroke(st, preview!.m));
    const b = strokesBounds(list, page.w / page.h)!;
    selectionEl.hidden = false;
    Object.assign(selectionEl.style, {
      left: `${b.minX * 100}%`,
      top: `${b.minY * 100}%`,
      width: `${(b.maxX - b.minX) * 100}%`,
      height: `${(b.maxY - b.minY) * 100}%`,
    });
  }
  const clearSelection = () => {
    selected = null;
    dragging = null;
    preview = null;
    placeSelection();
  };
  const drawLoop = () => {
    lassoPath.setAttribute("d", loop && loop.length >= 2 ? `M${loop.map((n, i) => (i % 2 ? `${n}` : `${i ? "L" : ""}${n}`)).join(" ")}Z` : "");
  };
  const dragTransform = (e: PointerEvent): Transform => {
    const d = dragging!;
    const [x, y] = toPage(e);
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
  };
  deleteBtn.onclick = () => {
    if (selected) commitAll(history, eraseOps(slide, [...selected]));
    clearSelection();
  };

  // --- Presenter: holding still to snap to a line or a box ---

  let hold: { x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null;
  let snapped = false;
  const cancelHold = () => {
    if (hold) clearTimeout(hold.timer);
    hold = null;
  };
  const armSnap = (e: PointerEvent) => {
    if (!draft || snapped || !advanced()) return;
    if (hold && Math.hypot(e.clientX - hold.x, e.clientY - hold.y) <= SNAP_HOLD_SLOP_PX) return;
    cancelHold();
    hold = {
      x: e.clientX,
      y: e.clientY,
      timer: setTimeout(() => {
        hold = null;
        if (!draft) return;
        const shape = snapShape(draft.stroke.points, page.w, page.h);
        if (!shape) return;
        draft.stroke.points.splice(0, draft.stroke.points.length, ...shape);
        snapped = true;
        predicted = [];
        stable.ctx.clearRect(0, 0, W, H);
        tip.ctx.clearRect(0, 0, W, H);
        draft.live.reset();
        schedule();
      }, SNAP_HOLD_MS),
    };
  };

  // --- Presenter input ---

  const drawingTool = () => tool === "pen" || tool === "highlighter";
  // Pencil mode: only a pen draws, and fingers pan, pinch and turn the page.
  // This device's, for the session: unset until a pen is first seen here,
  // which turns it on (and reveals the advanced tools).
  const pencil = (): boolean | null => {
    const v = presio.storage.get("pencil");
    return typeof v === "boolean" ? v : null;
  };
  const advanced = () => presio.settings.get("advanced") === true;
  // The pointer the current stroke, drag or line belongs to.
  let owner: number | null = null;
  const onPalette = (e: Event) => !!palette && palette.el.contains(e.target as Node);
  const onSelection = (e: Event) => selectionEl.contains(e.target as Node);
  // Whether this pointer may start something: in pencil mode a pen or a
  // mouse, not a finger (except on the selection, which a finger moves).
  // Pressed, a mouse draws the laser's line; a finger or a pen, the dot or
  // the line as the palette says (they have no hover to show the dot).
  const pressedLine = (e: PointerEvent) => e.pointerType === "mouse" || laserStyle().trail;
  const accepts = (e: PointerEvent) =>
    pencil() ? e.pointerType !== "touch" || (tool === "lasso" && onSelection(e)) : e.isPrimary && !pinching;
  let lastDrawTool: "pen" | "highlighter" = "pen";

  if (presenter) {
    window.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "pen" && pencil() === null) {
        presio.storage.set("pencil", true);
        if (!advanced()) void presio.settings.set("advanced", true);
        updateInteractive();
        palette?.render();
      }
      if (e.pointerType === "touch" && !pencil()) {
        touches.add(e.pointerId);
        if (touches.size >= 2) {
          pinching = true;
          abandonStroke();
          hideLaser();
          erasing = null;
          loop = null;
          drawLoop();
          if (dragging) {
            dragging = null;
            preview = null;
            redrawCommitted();
          }
          owner = null;
          return;
        }
      }
      if (owner !== null || !accepts(e) || onPalette(e)) return;
      if (tool === "lasso" && selected && onSelection(e)) {
        if (e.target === deleteBtn) return;
        owner = e.pointerId;
        document.body.setPointerCapture?.(e.pointerId);
        const corner = (e.target as HTMLElement).dataset?.corner ?? null;
        const b = strokesBounds(selectedStrokes(), page.w / page.h)!;
        dragging = { corner, from: toPage(e) as [number, number], box: b };
        return;
      }
      // The bars around the page are the palette's room, not the slide.
      if (!onPage(e) || e.button !== 0) return;
      owner = e.pointerId;
      document.body.setPointerCapture?.(e.pointerId);
      // Drawing (or erasing, or selecting) on hidden drawings shows them again.
      if (tool !== "laser" && presio.settings.get("hidden") === true) void presio.settings.set("hidden", false);
      if (drawingTool()) {
        const t = tool as "pen" | "highlighter";
        const style = styleOf(t);
        snapped = false;
        startStroke({ id: newId(), tool: t, color: style.color, width: style.size, points: toPage(e) });
        armSnap(e);
      } else if (tool === "laser") {
        const [x, y] = toPage(e);
        moveLaser(x, y, pressedLine(e));
      } else if (tool === "eraser") {
        erasing = { group: newGroup(), hit: new Set() };
        eraseAt(e);
      } else if (tool === "lasso") {
        clearSelection();
        loop = toPage(e);
        drawLoop();
      }
    });

    window.addEventListener("pointermove", (e) => {
      if (tool === "eraser" && e.pointerType !== "touch") showRing(onPage(e) ? e : null);
      if (pinching && !pencil()) return;
      if (owner === null) {
        // A mouse's dot follows it hovering; the line needs the button down.
        if (tool === "laser" && e.pointerType === "mouse" && !onPalette(e) && onPage(e)) {
          const [x, y] = toPage(e);
          moveLaser(x, y, false);
        } else if (tool === "laser" && laser && e.pointerType === "mouse") hideLaser();
        return;
      }
      if (e.pointerId !== owner) return;
      const samples = e.getCoalescedEvents?.() ?? [e];
      if (draft) {
        if (!snapped) for (const c of samples) addPoint(c);
        predicted = snapped ? [] : predict(e);
        armSnap(e);
        schedule();
      } else if (tool === "laser") {
        if (!onPalette(e) && onPage(e)) {
          const [x, y] = toPage(e);
          moveLaser(x, y, pressedLine(e));
        } else if (laser) hideLaser();
      } else if (erasing) {
        for (const c of samples) eraseAt(c);
      } else if (loop) {
        for (const c of samples) loop.push(...toPage(c));
        drawLoop();
      } else if (dragging) {
        preview = { ids: selected!, m: dragTransform(e) };
        redrawCommitted();
        placeSelection();
      }
    });

    const end = (e: PointerEvent) => {
      if (e.pointerType === "touch") {
        touches.delete(e.pointerId);
        if (!touches.size) pinching = false;
      }
      if (e.pointerId !== owner) return;
      owner = null;
      cancelHold();
      if (draft) {
        if (e.type === "pointerup" && !snapped) addPoint(e);
        finishStroke();
      }
      if (tool === "laser") {
        if (e.pointerType !== "mouse" || !onPage(e)) hideLaser();
        else {
          // Back to the dot where the button came up.
          const [x, y] = toPage(e);
          moveLaser(x, y, false);
        }
      }
      erasing = null;
      if (loop) {
        const poly = loop;
        loop = null;
        drawLoop();
        const hit = strokesOf(history.state, slide).filter((st) => lassoContains(poly, st));
        selected = hit.length ? new Set(hit.map((st) => st.id)) : null;
        placeSelection();
      }
      if (dragging) {
        const m = preview?.m;
        dragging = null;
        preview = null;
        const moved = m && (m[0] !== 1 || m[1] !== 0 || m[2] !== 0);
        if (moved && e.type === "pointerup") commitAll(history, moveOps(slide, [...selected!], m));
        else redrawCommitted();
      }
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    document.documentElement.addEventListener("pointerleave", (e) => {
      if (e.pointerType === "mouse" && tool === "laser" && owner === null) hideLaser();
      if (e.pointerType === "mouse") showRing(null);
    });

    // Finger taps: in pencil mode a double-tap swaps between the eraser and
    // the drawing tool, standing in for the Apple Pencil's own; with any tool,
    // a two-finger double-tap undoes.
    const flash = document.createElement("div");
    flash.className = "tool-flash";
    flash.style.opacity = "0";
    root.append(flash);
    let flashTimer: ReturnType<typeof setTimeout> | null = null;
    watchTaps({
      oneFinger: () => pencil() === true && (drawingTool() || tool === "eraser"),
      onDoubleTap: (x, y) => {
        const next = tool === "eraser" ? lastDrawTool : "eraser";
        setTool(next);
        flash.innerHTML = icon(next);
        flash.style.transform = `translate(${x}px, ${y}px)`;
        flash.style.opacity = "1";
        if (flashTimer) clearTimeout(flashTimer);
        flashTimer = setTimeout(() => (flash.style.opacity = "0"), 600);
      },
      twoFinger: () => tool !== "none",
      onTwoFingerDoubleTap: () => commitAll(history, undoOps(history, slide)),
      ignore: (target) => !!palette && palette.el.contains(target as Node),
    });
  }

  // --- Presenter: palette and tools ---

  const touchFirst = matchMedia("(pointer: coarse)").matches;
  let palette: Palette | null = null;

  const setTool = (next: Tool) => {
    presio.storage.set("tool", next);
    applyTool(next);
  };

  const applyTool = (next: Tool) => {
    if (next === tool) return;
    if (draft) finishStroke();
    if (tool === "laser") hideLaser();
    erasing = null;
    loop = null;
    drawLoop();
    tool = next;
    if (tool === "pen" || tool === "highlighter") lastDrawTool = tool;
    clearSelection();
    showRing(null);
    document.body.classList.toggle("drawing", tool !== "none");
    palette?.render();
    updateInteractive();
  };

  let interactiveKey = "";
  const updateInteractive = () => {
    if (!presenter) return;
    const value = tool !== "none" ? (pencil() ? "pen" : true) : palette ? [palette.region()] : false;
    const key = JSON.stringify(value);
    if (key === interactiveKey) return;
    interactiveKey = key;
    presio.ui.setInteractive(value);
  };

  const showPalette = () => {
    const wanted = presenter && presio.settings.get("toolbar") !== false;
    if (wanted && !palette) {
      palette = new Palette(root, {
        tool: () => tool,
        setTool,
        style: styleOf,
        setStyle: (t, style) => {
          const current = styleOf(t);
          if (style.color && style.color !== current.color) void presio.settings.set(`${t}Color`, style.color);
          if (style.size && style.size !== current.size) void presio.settings.set(`${t}Size`, style.size);
        },
        laser: laserStyle,
        laserModes: () => touchFirst || pencil() === true,
        setLaser: (style) => {
          const current = laserStyle();
          if (style.size !== undefined && style.size !== current.size) void presio.settings.set("laserSize", style.size);
          if (style.trail !== undefined && style.trail !== current.trail) void presio.settings.set("laserTrail", style.trail);
        },
        advanced,
        pencil,
        setPencil: (on) => {
          presio.storage.set("pencil", on);
          updateInteractive();
          palette?.render();
        },
        hidden: () => presio.settings.get("hidden") === true,
        setHidden: (hidden) => void presio.settings.set("hidden", hidden),
        canUndo: () => canUndo(history, slide),
        canRedo: () => canRedo(history, slide),
        canClear: () => strokesOf(history.state, slide).length > 0,
        undo: () => commitAll(history, undoOps(history, slide)),
        redo: () => commitAll(history, redoOps(history, slide)),
        clear: () => commitAll(history, clearOps(history.state, slide)),
        changed: () => requestAnimationFrame(updateInteractive),
      });
      palette.setView(presio.ui.view);
      palette.setDimmed(!touchFirst && !presio.ui.hovered);
    } else if (!wanted && palette) {
      palette.el.remove();
      palette = null;
      setTool("none");
    }
    updateInteractive();
  };

  if (presenter) {
    // The palette is drawn in Presio's colors.
    const theme = () => (document.documentElement.className = presio.theme);
    theme();
    presio.onContextChange(() => {
      theme();
      // The tooltips name the presenter's keys, which may have changed.
      palette?.render();
    });
    tool = "none";
    const stored = presio.storage.get("tool");
    if (isTool(stored)) applyTool(stored);
    presio.storage.onChange((all) => {
      applyTool(isTool(all.tool) ? all.tool : "none");
      updateInteractive();
    });
    presio.settings.onChange(() => {
      showPalette();
      palette?.render();
    });
    presio.ui.onHover((hovered) => {
      palette?.setDimmed(!touchFirst && !hovered);
      // A mouse that wandered off leaves nothing to point at.
      if (!hovered && tool === "laser") hideLaser();
    });
    showPalette();
  } else {
    // A viewer's own download gets what's drawn too.
    // pdf-lib only loads when a download asks for it.
    presio.deck.onExport(async (bytes) => (await import("./bake")).bakeDrawing(bytes, (await history.whenReady()).state));
  }

  // Hidden drawings (the palette's eye): on every screen.
  const showHidden = () => pageEl.classList.toggle("hidden-drawings", presio.settings.get("hidden") === true);
  showHidden();
  presio.settings.onChange(showHidden);

  presio.ui.onViewChange((view) => {
    palette?.setView(view);
    resize();
  });
  presio.ui.onPageChange(() => resize());
  window.addEventListener("resize", () => {
    resize();
    palette?.setView(presio.ui.view);
  });

  // --- Messages ---

  history.onChange(() => {
    if (strokesOf(history.state, slide) !== drawn) redrawCommitted();
    else renderPalette();
  });

  presio.messages.onMessage(({ type, payload }) => {
    if (presenter) return;
    if (type === "b") {
      const b = parseBegin(payload);
      if (b) beginDraft({ id: b.id, tool: b.tool, color: b.color, width: b.width, points: b.points }, b.slide);
    } else if (type === "p") {
      const p = payload as { i?: unknown; d?: unknown } | null;
      const points = decodePoints(p?.d);
      if (draft && points && p?.i === draft.stroke.id) {
        draft.stroke.points.push(...points);
        schedule();
      }
    } else if (type === "x") {
      if (draft && (payload as { i?: unknown } | null)?.i === draft.stroke.id) endDraft();
    } else if (type === "l") {
      onRemoteLaser(payload);
    }
  });

  presio.slide.onChange(({ current }) => {
    if (current === slide) return;
    // A stroke in progress belongs to the slide it began on.
    if (presenter && draft) finishStroke();
    if (presenter) clearSelection();
    slide = current;
    drawn = null;
    redrawCommitted();
    if (draft) {
      stable.ctx.clearRect(0, 0, W, H);
      tip.ctx.clearRect(0, 0, W, H);
      draft.live.reset();
      schedule();
    }
  });

  // A different document: a stroke in progress was on the old one. (What's
  // drawn stays with the same page count; otherwise the history starts over.)
  presio.deck.onChange((kind) => {
    if (kind !== "replace") return;
    if (draft) endDraft();
    forgetDecoded();
  });

  resize();
}
