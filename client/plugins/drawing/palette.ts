// The presenter's tool palette, drawn on their current slide.
//
// Movable by its grip, and turned on its side by double-clicking it. With a
// tool active a second panel offers what goes with it: a pen's colors and
// widths, the laser's look, and undo, redo and clear; clicking the active tool
// again tucks that panel away. While a tool is in use and the pointer is away
// from the palette, it collapses to the grip and the active tool, so it stays
// out of the slide (after a moment, so crossing to the panel never closes
// it); and with the mouse off the slide altogether it fades out. It keeps its
// size and place on screen when the presenter pinches in.
//
// The eraser and the lasso show with the "Advanced tools" setting (on by
// default); turned off, the palette keeps to the few tools most talks need.

import { icon } from "./icons";
import type { Tool } from "./model";

export const PEN_COLORS = ["#111111", "#e11d48", "#2563eb", "#16a34a", "#f59e0b", "#9333ea"];
export const HIGHLIGHTER_COLORS = ["#facc15", "#a3e635", "#22d3ee", "#f472b6", "#fb923c", "#c084fc"];
const PEN_SIZES = [2, 3, 5, 8];
const HIGHLIGHTER_SIZES = [8, 14, 20, 28];
export const LASER_SIZES = [8, 16, 24, 32];
// How long the pointer may be away before the palette collapses.
const COLLAPSE_DELAY_MS = 700;

// A tooltip with the presenter's key for the command, if they have one.
const withKey = (label: string, command: string) => {
  const key = presio.commands.shortcut(command);
  return key ? `${label} (${key})` : label;
};

const TOOLS: { key: Tool; icon: string; label: string; advanced?: boolean }[] = [
  { key: "none", icon: "pointer", label: "Pointer (no tool)" },
  { key: "laser", icon: "laser", label: "Laser pointer" },
  { key: "pen", icon: "pen", label: "Draw" },
  { key: "highlighter", icon: "highlighter", label: "Highlight" },
  { key: "eraser", icon: "eraser", label: "Erase", advanced: true },
  { key: "lasso", icon: "lasso", label: "Select: drag to move, corner to resize", advanced: true },
];

export interface PenStyle {
  color: string;
  size: number;
}

export interface LaserStyle {
  /** Pixels on a 960px-wide slide. */
  size: number;
  /** A fading line behind it, rather than a dot alone. */
  trail: boolean;
}

export interface PaletteActions {
  tool(): Tool;
  setTool(tool: Tool): void;
  style(tool: "pen" | "highlighter"): PenStyle;
  setStyle(tool: "pen" | "highlighter", style: Partial<PenStyle>): void;
  laser(): LaserStyle;
  setLaser(style: Partial<LaserStyle>): void;
  /** Whether the dot-or-line choice shows: a mouse always has both (the dot
   *  while hovering, the line while pressed), so only touch screens need it. */
  laserModes(): boolean;
  /** Whether the eraser and lasso show. */
  advanced(): boolean;
  /** Pencil mode (only a pen draws), or null while no pen has been seen. */
  pencil(): boolean | null;
  setPencil(on: boolean): void;
  /** Whether the drawings are hidden, on every screen. */
  hidden(): boolean;
  setHidden(hidden: boolean): void;
  /** Whether this device has a change on the current slide to undo, or redo. */
  canUndo(): boolean;
  canRedo(): boolean;
  /** Whether the current slide has anything drawn on it. */
  canClear(): boolean;
  undo(): void;
  redo(): void;
  clear(): void;
  /** The palette moved or changed shape: where it takes input changed. */
  changed(): void;
}

export class Palette {
  readonly el = document.createElement("div");
  private tools = document.createElement("div");
  private options: HTMLElement | null = null;
  private optionsOpen = true;
  // Expanded while the mouse is on it, or "pinned" open: the touch path,
  // where there's no hover. Picking a tool pins it so it survives the finger
  // lifting; touching anywhere else (starting to draw) unpins it.
  private hovered = false;
  private pinned = false;
  private horizontal = false;
  /** Offset from the visible area's top-left, in screen pixels. */
  private pos = { x: 8, y: 8 };
  private view = { x: 0, y: 0, w: 1, h: 1, scale: 1 };
  private drag: { x: number; y: number; px: number; py: number } | null = null;
  private collapseTimer: ReturnType<typeof setTimeout> | null = null;

  private actions: PaletteActions;

  constructor(parent: HTMLElement, actions: PaletteActions) {
    this.actions = actions;
    this.el.className = "palette";
    // A finger works it even while fingers are otherwise the slide's (pencil mode).
    this.el.dataset.control = "";
    this.tools.className = "panel tools";
    this.el.append(this.tools);
    this.el.addEventListener("pointerenter", (e) => {
      if (e.pointerType !== "mouse") return;
      this.cancelCollapse();
      this.setHovered(true);
    });
    this.el.addEventListener("pointerleave", (e) => {
      if (e.pointerType === "mouse") this.collapseSoon();
    });
    // A click that reached the palette while the frame wasn't taking input
    // (Presio forwards those) leaves no pointerleave behind: a mouse seen
    // anywhere else on the slide has left it all the same.
    document.addEventListener("pointermove", (e) => {
      if (e.pointerType !== "mouse") return;
      if (this.el.contains(e.target as Node)) this.cancelCollapse();
      else if (this.pinned || this.hovered) this.collapseSoon();
    });
    document.addEventListener("pointerdown", (e) => {
      if (this.pinned && !this.el.contains(e.target as Node)) {
        this.pinned = false;
        this.render();
      }
    });
    parent.append(this.el);
    this.render();
  }

  private cancelCollapse() {
    if (this.collapseTimer) clearTimeout(this.collapseTimer);
    this.collapseTimer = null;
  }

  private collapseSoon() {
    if (this.collapseTimer) return;
    this.collapseTimer = setTimeout(() => {
      this.collapseTimer = null;
      this.pinned = false;
      this.hovered = false;
      this.render();
    }, COLLAPSE_DELAY_MS);
  }

  private setHovered(hovered: boolean) {
    if (this.hovered === hovered) return;
    this.hovered = hovered;
    this.render();
  }

  setDimmed(dimmed: boolean) {
    this.el.classList.toggle("dimmed", dimmed);
  }

  setView(view: { x: number; y: number; w: number; h: number; scale: number }) {
    this.view = view;
    this.place();
  }

  /** The palette's box, as page fractions. */
  region() {
    const r = this.el.getBoundingClientRect();
    return { x: r.left / innerWidth, y: r.top / innerHeight, w: r.width / innerWidth, h: r.height / innerHeight };
  }

  private place() {
    const { x, y, w, h, scale } = this.view;
    // Kept inside what's on screen, at screen size.
    const maxX = Math.max(0, w * innerWidth * scale - this.el.offsetWidth);
    const maxY = Math.max(0, h * innerHeight * scale - this.el.offsetHeight);
    const px = Math.min(Math.max(0, this.pos.x), maxX);
    const py = Math.min(Math.max(0, this.pos.y), maxY);
    this.el.style.transform = `translate(${x * innerWidth + px / scale}px, ${y * innerHeight + py / scale}px) scale(${1 / scale})`;
    this.actions.changed();
  }

  render() {
    const tool = this.actions.tool();
    const expanded = tool === "none" || this.hovered || this.pinned;
    this.el.classList.toggle("horizontal", this.horizontal);

    const grip = document.createElement("div");
    grip.className = "grip";
    grip.title = "Drag to move — double-click to turn the palette on its side";
    grip.dataset.testid = "toolbar-drag";
    grip.innerHTML = icon(this.horizontal ? "gripV" : "gripH");
    grip.onpointerdown = (e) => {
      if (!e.isPrimary) return;
      grip.setPointerCapture(e.pointerId);
      this.drag = { x: e.clientX, y: e.clientY, px: this.pos.x, py: this.pos.y };
    };
    grip.onpointermove = (e) => {
      if (!this.drag) return;
      const s = this.view.scale;
      this.pos = { x: this.drag.px + (e.clientX - this.drag.x) * s, y: this.drag.py + (e.clientY - this.drag.y) * s };
      this.place();
    };
    grip.onpointerup = grip.onpointercancel = () => {
      if (!this.drag) return;
      this.drag = null;
      // Remember where it was actually drawn, not where the pointer strayed to.
      const maxX = Math.max(0, this.view.w * innerWidth * this.view.scale - this.el.offsetWidth);
      const maxY = Math.max(0, this.view.h * innerHeight * this.view.scale - this.el.offsetHeight);
      this.pos = { x: Math.min(Math.max(0, this.pos.x), maxX), y: Math.min(Math.max(0, this.pos.y), maxY) };
    };
    grip.ondblclick = () => {
      this.horizontal = !this.horizontal;
      this.render();
    };

    const advanced = this.actions.advanced();
    const pencil = this.actions.pencil();
    const hidden = this.actions.hidden();
    const buttons = expanded
      ? [
          ...TOOLS.filter((t) => !t.advanced || advanced || t.key === tool).map((t) =>
            this.button(t.icon, withKey(t.label, t.key === "none" ? "pointer" : t.key), `tool-${t.key}`, () => this.select(t.key), tool === t.key)
          ),
          ...(pencil === null
            ? []
            : [
                this.button(
                  pencil ? "penTool" : "hand",
                  pencil ? "Pencil only: fingers pan and zoom. Tap to draw with fingers too" : "Pencil and fingers draw. Tap for pencil only",
                  "pencil-mode",
                  () => this.actions.setPencil(!pencil),
                  pencil
                ),
              ]),
          this.button(
            hidden ? "eyeOff" : "eye",
            withKey(hidden ? "Drawings hidden on every screen: tap to show them" : "Hide the drawings on every screen", "toggleDrawings"),
            "toggle-drawings",
            () => this.actions.setHidden(!hidden),
            hidden
          ),
        ]
      : [
          this.button(
            TOOLS.find((t) => t.key === tool)!.icon,
            `${TOOLS.find((t) => t.key === tool)!.label} — tap to show all tools`,
            "tool-collapsed",
            () => {
              this.pinned = true;
              this.render();
            },
            true
          ),
        ];
    this.tools.replaceChildren(grip, ...buttons);

    this.options?.remove();
    this.options = null;
    if (tool !== "none" && expanded && this.optionsOpen) {
      this.options = this.renderOptions(tool);
      this.el.append(this.options);
    }
    this.place();
  }

  private select(key: Tool) {
    const tool = this.actions.tool();
    if (key === tool) {
      // Re-clicking the active tool tucks its options away, or back.
      if (tool !== "none") {
        this.optionsOpen = !this.optionsOpen;
        this.render();
      }
      return;
    }
    this.optionsOpen = true;
    // Kept open so a color or width can be picked next; it collapses once the
    // slide (or anything else) is touched.
    this.pinned = true;
    this.actions.setTool(key);
  }

  private button(name: string, title: string, testid: string, onClick: () => void, on = false, disabled = false) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = on ? "btn on" : "btn";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.setAttribute("aria-pressed", String(on));
    b.dataset.testid = testid;
    b.disabled = disabled;
    b.innerHTML = icon(name);
    b.onclick = onClick;
    return b;
  }

  private renderOptions(tool: Exclude<Tool, "none">) {
    const panel = document.createElement("div");
    panel.className = "panel options";
    if (tool === "laser") {
      panel.dataset.testid = "laser-options";
      panel.append(this.renderLaserOptions());
      return panel;
    }
    panel.dataset.testid = "pen-options";
    if (tool === "pen" || tool === "highlighter") panel.append(...this.renderPenOptions(tool));

    const actions = document.createElement("div");
    actions.className = tool === "pen" || tool === "highlighter" ? "actions" : "actions bare";
    actions.append(
      this.button("undo", withKey("Undo (or double-tap with two fingers)", "undo"), "pen-undo", () => this.actions.undo(), false, !this.actions.canUndo()),
      this.button("redo", withKey("Redo", "redo"), "pen-redo", () => this.actions.redo(), false, !this.actions.canRedo()),
      this.button("trash", withKey("Clear drawings on this slide", "clear"), "pen-clear", () => this.actions.clear(), false, !this.actions.canClear())
    );
    panel.append(actions);
    return panel;
  }

  private renderPenOptions(tool: "pen" | "highlighter") {
    const style = this.actions.style(tool);
    const colors = document.createElement("div");
    colors.className = "colors";
    for (const color of tool === "highlighter" ? HIGHLIGHTER_COLORS : PEN_COLORS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = style.color === color ? "color on" : "color";
      b.title = color;
      b.dataset.testid = `pen-color-${color.slice(1)}`;
      b.style.backgroundColor = color;
      b.onclick = () => this.actions.setStyle(tool, { color });
      colors.append(b);
    }

    const sizes = document.createElement("div");
    sizes.className = "sizes";
    for (const px of tool === "highlighter" ? HIGHLIGHTER_SIZES : PEN_SIZES) {
      sizes.append(this.sizeButton(px, Math.abs(style.size - px) < 0.05, `pen-size-${px}`, `${px}px line`, "", () => this.actions.setStyle(tool, { size: px })));
    }
    return [colors, sizes];
  }

  private renderLaserOptions() {
    const style = this.actions.laser();
    const wrap = document.createElement("div");
    wrap.className = "laser-options";
    if (this.actions.laserModes()) {
      const modes = document.createElement("div");
      modes.className = "sizes";
      modes.append(
        this.button("dot", "Point", "laser-mode-dot", () => this.actions.setLaser({ trail: false }), !style.trail),
        this.button("trail", "Fading line", "laser-mode-trail", () => this.actions.setLaser({ trail: true }), style.trail)
      );
      wrap.append(modes);
    }
    const sizes = document.createElement("div");
    sizes.className = "sizes";
    for (const px of LASER_SIZES) {
      sizes.append(this.sizeButton(px, style.size === px, `laser-size-${px}`, `${px}px`, "#ef4444", () => this.actions.setLaser({ size: px })));
    }
    wrap.append(sizes);
    return wrap;
  }

  private sizeButton(px: number, on: boolean, testid: string, title: string, color: string, onClick: () => void) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = on ? "size on" : "size";
    b.title = title;
    b.dataset.testid = testid;
    b.setAttribute("aria-pressed", String(on));
    const dot = document.createElement("span");
    const d = Math.min(18, Math.max(3, px * (color ? 0.45 : 1.2)));
    dot.style.width = dot.style.height = `${d}px`;
    if (color) dot.style.background = color;
    b.append(dot);
    b.onclick = onClick;
    return b;
  }
}
