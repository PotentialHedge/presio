// The laser: a dot that follows the pointer (a mouse's even hovering), or a
// fading line drawn while pressed. The presenter moves it and sends where it
// is; a viewer follows. "l" carries { x, y, s: size, t: 1 for the line }, or
// null when it's put away.

import type { LaserStyle } from "./palette";
import { LaserTrail } from "./trail";

// How long a viewer keeps showing a laser dot that stopped moving (covers a
// lost "hide").
const LASER_HIDE_MS = 3000;

export const laserSizeOf = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.min(48, Math.max(4, v)) : 16);

export class Laser {
  private dot: HTMLElement;
  private page: () => { w: number; h: number };
  private style: () => LaserStyle;
  private schedule: () => void;
  private trail: LaserTrail;

  // Presenter: where it is, and what was last sent.
  private at: { x: number; y: number } | null = null;
  private sent: { x: number; y: number } | null = null;
  // Whether the presenter's laser is drawing a line now, rather than the dot.
  private line = false;

  // Viewer: the dot glides from where it is to each new position over about
  // the time between updates, so a 60 Hz stream reads as motion, not steps.
  private remote: { fx: number; fy: number; tx: number; ty: number; t0: number; dur: number; at: number } | null = null;
  private remoteSize = 16;
  private remoteTrail = false;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: {
    dot: HTMLElement;
    trailCanvas: HTMLCanvasElement;
    /** The page's size in CSS pixels. */
    page: () => { w: number; h: number };
    style: () => LaserStyle;
    /** Ask for a frame (where send() and step() run). */
    schedule: () => void;
  }) {
    this.dot = opts.dot;
    this.page = opts.page;
    this.style = opts.style;
    this.schedule = opts.schedule;
    this.trail = new LaserTrail(opts.trailCanvas, () => ({ ...this.page(), resolution: window.devicePixelRatio || 1 }));
  }

  /** Whether the presenter's laser is out. */
  get active() {
    return this.at !== null;
  }

  private sizeDot(size: number) {
    const d = Math.max(6, (size / 960) * this.page().w);
    Object.assign(this.dot.style, { width: `${d}px`, height: `${d}px`, margin: `${-d / 2}px 0 0 ${-d / 2}px` });
  }

  private show(x: number, y: number) {
    const { w, h } = this.page();
    this.dot.hidden = false;
    this.dot.style.transform = `translate(${x * w}px, ${y * h}px)`;
  }

  /** The presenter's laser at (x, y): the dot, or the line. */
  move(x: number, y: number, line: boolean) {
    if (this.line !== line && this.at) {
      if (this.line) this.trail.push(null);
      this.sent = null;
    }
    this.line = line;
    this.at = { x, y };
    const { size } = this.style();
    if (line) {
      this.dot.hidden = true;
      this.trail.push({ x, y, size });
    } else {
      this.sizeDot(size);
      this.show(x, y);
    }
    this.schedule();
  }

  /** Puts the presenter's laser away, and tells the viewers. */
  hide() {
    this.dot.hidden = true;
    if (this.at || this.sent) presio.messages.send("l", null);
    if (this.at) this.trail.push(null);
    this.at = null;
    this.sent = null;
  }

  /** Once a frame (presenter): where it is now, when that changed. */
  send() {
    const at = this.at;
    if (!at || (this.sent && this.sent.x === at.x && this.sent.y === at.y)) return;
    this.sent = at;
    const { size } = this.style();
    presio.messages.send("l", { x: Math.round(at.x * 1e4) / 1e4, y: Math.round(at.y * 1e4) / 1e4, s: size, ...(this.line && { t: 1 }) }, { volatile: true });
  }

  /** Once a frame (viewer): moves the dot along; true while it's still gliding. */
  step(): boolean {
    const r = this.remote;
    if (!r) return false;
    const k = Math.min(1, (performance.now() - r.t0) / r.dur);
    this.show(r.fx + (r.tx - r.fx) * k, r.fy + (r.ty - r.fy) * k);
    return k < 1;
  }

  /** A viewer heard the presenter's laser. */
  receive(payload: unknown) {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    const p = payload as { x?: unknown; y?: unknown; s?: unknown; t?: unknown } | null;
    if (!p || typeof p.x !== "number" || typeof p.y !== "number") {
      this.remote = null;
      this.dot.hidden = true;
      if (this.remoteTrail) this.trail.push(null);
      this.remoteTrail = false;
      return;
    }
    const size = laserSizeOf(p.s);
    if (p.t === 1) {
      this.remote = null;
      this.dot.hidden = true;
      this.remoteTrail = true;
      this.trail.push({ x: p.x, y: p.y, size });
      return;
    }
    if (this.remoteTrail) this.trail.push(null);
    this.remoteTrail = false;
    if (size !== this.remoteSize) this.sizeDot((this.remoteSize = size));
    const now = performance.now();
    const prev = this.remote;
    const k = prev ? Math.min(1, (now - prev.t0) / prev.dur) : 1;
    const fx = prev && !this.dot.hidden ? prev.fx + (prev.tx - prev.fx) * k : p.x;
    const fy = prev && !this.dot.hidden ? prev.fy + (prev.ty - prev.fy) * k : p.y;
    const dur = prev ? Math.min(60, Math.max(8, now - prev.at)) : 16;
    this.remote = { fx, fy, tx: p.x, ty: p.y, t0: now, dur, at: now };
    this.hideTimer = setTimeout(() => {
      this.remote = null;
      this.dot.hidden = true;
    }, LASER_HIDE_MS);
    this.schedule();
  }
}
