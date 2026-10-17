// What the host's namespace modules share: a connected frame, the shape of a
// method in the dispatch table, and the core each module is built on.

import type { ErrorCode } from "@shared/plugin/protocol";
import type { LoadedPlugin, PluginPermission, PluginSurface } from "../manifest";

export type PluginRole = "presenter" | "audience";

export interface PluginContext {
  role: PluginRole;
  theme: "light" | "dark";
  session: { id: string; local: boolean; joinUrl: string | null };
  slide: { current: number; total: number };
}

/** The part of a "slide" surface on screen (fractions of it: page fractions
 *  for one sized to the page), and the zoom it's drawn at. */
export interface SlideView {
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
}

export const FULL_VIEW: SlideView = { x: 0, y: 0, w: 1, h: 1, scale: 1 };

/** Where the page is within a "slide" surface, as fractions of it: all of it,
 *  unless the surface covers the slide area around the page too. */
export interface SlidePage {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const FULL_PAGE: SlidePage = { x: 0, y: 0, w: 1, h: 1 };

/** Where a slide surface takes pointer input: none, all, some areas, or
 *  "pen": a pen's and a mouse's, while fingers stay Presio's (pan, pinch, tap
 *  to turn the page) — the plugin still sees them. */
export type Interactive = boolean | "pen" | { x: number; y: number; w: number; h: number }[];

/** What a mounted frame wants told about it. */
export interface FrameHooks {
  /** Viewer surface: show or hide its layer. */
  onVisible?: (visible: boolean) => void;
  /** Slide surface: where it takes pointer input. */
  onInteractive?: (value: Interactive) => void;
  /** The plugin's document is in place (after boot). */
  onReady?: () => void;
  /** Viewer sheet: how tall the plugin's document is (CSS pixels). */
  onContentSize?: (height: number) => void;
}

/** One mounted frame, as the host knows it. */
export interface Conn extends FrameHooks {
  plugin: LoadedPlugin;
  surface: PluginSurface;
  /** Panel surface: which of the plugin's panels this frame draws. */
  panel?: string;
  port: MessagePort;
  /** Commands this frame registered handlers for (presio.commands.register). */
  commands: Set<string>;
  /** It registered presio.deck.onExport. */
  exporter: boolean;
  /** It opened presio.history (and can take snapshots of it). */
  history: boolean;
  snapshots: boolean;
}

/** A call failing with one of the protocol's error codes. */
export class HostError extends Error {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** Params as an object to read fields from ({} when they aren't one). */
export type Params = Record<string, unknown>;

/** One method in the dispatch table. */
export interface MethodSpec {
  /** Checked before the handler runs: the manifest must ask for it. */
  permission?: PluginPermission;
  /** The handler's result is the call's; throw a HostError to fail it. */
  handler(conn: Conn, params: Params): unknown;
}

export type MethodTable = Record<string, MethodSpec>;

/** What the modules are built on: the frames, the context, and the port. */
export interface HostCore {
  readonly ctx: PluginContext;
  /** Every connected frame. */
  frames(): Iterable<Conn>;
  /** One plugin's connected frames. */
  framesOf(pluginId: string): Conn[];
  /** Tell a frame something (an event). */
  emit(conn: Conn, method: string, params?: unknown): void;
  /** Ask a frame something; rejects after `timeoutMs`. */
  call<T>(conn: Conn, method: string, params: unknown, timeoutMs: number): Promise<T>;
}

// Which of a plugin's frames takes work first: the presenter's background
// (always up while the deck is), then a panel; on a viewer, the sheet, then
// the viewer layer, then the slide layer.
const FRAME_PRIORITY: PluginSurface[] = ["background", "panel", "viewerSheet", "viewer", "slide"];

/** The frame to send work to when several of a plugin's could take it. */
export function primaryFrame(frames: Conn[]): Conn | undefined {
  for (const surface of FRAME_PRIORITY) {
    const conn = frames.find((c) => c.surface === surface);
    if (conn) return conn;
  }
  return frames[0];
}

/** A plugin-given box (fractions): finite, with a positive size; else null. */
export function parseRect(r: Record<string, unknown>): SlidePage | null {
  const { x, y, w, h } = r;
  if (![x, y, w, h].every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  const rect = { x, y, w, h } as SlidePage;
  return rect.w > 0 && rect.h > 0 ? rect : null;
}

export const requireString = (params: Params, key: string, method: string): string => {
  const v = params[key];
  if (typeof v !== "string" || !v) throw new HostError("InvalidParams", `${method} needs "${key}", a string`);
  return v;
};
