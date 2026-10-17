// Types for `window.presio`, plugin API version 1: what
// public/plugin-frame.html installs in each plugin frame. Keep in step with
// that file, shared/plugin/protocol.ts and /plugins.md.

type Unsubscribe = () => void;

/** A still image on a slide, at page fractions (presio.layers). */
interface PresioLayerItem {
  x: number;
  y: number;
  w: number;
  h: number;
  /** data:image/…, blob: or https: URL. */
  image: string;
  fit?: "cover" | "contain";
}

interface PresioView {
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
}

/** A row of a button's menu (presio.ui.setButton's `menu`). */
type PresioMenuEntry =
  | { id: string; label: string; checked?: boolean; disabled?: boolean }
  | { heading: string }
  | { separator: true };

/** A status item's content (presio.ui.setStatus). */
interface PresioStatus {
  text: string;
  tooltip?: string;
  icon?: PresioIcon;
  /** One of the plugin's commands, run by a click on the item. */
  command?: string;
  args?: unknown;
}

/** Icons a contribution may name. */
type PresioIcon =
  | "qr-code" | "bar-chart" | "message" | "users" | "timer" | "bell" | "star" | "sparkles" | "hand" | "check" | "eye"
  | "megaphone" | "pen" | "download" | "upload";

/** A file the presenter picked for a button with "accept" (a command's args.file). */
interface PresioFile {
  name: string;
  type: string;
  bytes: Uint8Array;
}

interface PresioMessage {
  type: string;
  payload: unknown;
  from: "presenter" | "audience";
  sender?: string;
}

/** An op's place in a history (presio.history), as apply() sees it. */
interface PresioHistoryEntryInfo {
  id: string;
  /** The device that committed it (compare with PresioHistory.device). */
  by: string | null;
  /** Server time it was ordered at; absent while pending. */
  at?: number;
  /** Its place in the order; absent while pending. */
  seq?: number;
  pending: boolean;
}

interface PresioHistorySpec<S, Op> {
  init(): S;
  /** The next state; must not change the one it's given. */
  apply(state: S, op: Op, entry: PresioHistoryEntryInfo): S;
  /** JSON the history can start from, for a history that grows. */
  snapshot?(state: S): unknown;
  restore?(snapshot: unknown): S;
}

interface PresioHistory<S, Op> {
  /** Ordered entries applied to init(), then this device's pending ops. */
  readonly state: S;
  /** The ordered entries only: what every device agrees on. */
  readonly confirmed: S;
  readonly ready: boolean;
  whenReady(): Promise<PresioHistory<S, Op>>;
  /** This browser's id: entries' `by`. */
  readonly device: string | null;
  /** Presenter: add an op (JSON, at most 16 KB). Returns its id. */
  commit(op: Op): string;
  /** This device's ops, newest first; seq is null while pending. */
  mine(): { id: string; op: Op; seq: number | null }[];
  onChange(cb: (state: S, change: { kind: "state" | "entry" | "pending"; entry?: unknown }) => void): Unsubscribe;
  onError(cb: (id: string, message: string) => void): Unsubscribe;
}

/** Viewers' values under a key, counted (presio.audience.summary). */
interface PresioAudienceSummary {
  /** How many viewers have a value. */
  total: number;
  /** Identical values (compared as JSON with sorted keys), most common first. */
  values: { value: unknown; count: number }[];
}

/** Viewers' values under a key changed (presio.audience.onChange). */
interface PresioAudienceChange {
  key: string;
  summary: PresioAudienceSummary;
  /** By viewer id, since the last change: the new value, or null when removed. */
  changes: Record<string, unknown>;
  /** The values were replaced wholesale (cleared, or re-synced): read all(). */
  reset: boolean;
}

/** What a host can do (presio.supports()); see shared/plugin/protocol.ts. */
type PresioCapability =
  | "slide" | "context" | "settings" | "storage" | "messages" | "commands" | "deck" | "layers"
  | "history" | "blobs" | "clock" | "ui" | "panels" | "audience" | "status" | "viewerSheet" | "palette";

/** Why a call failed: an Error with one of these as `code`. */
type PresioErrorCode = "MethodNotFound" | "PermissionDenied" | "InvalidParams" | "Unavailable" | "Internal";

interface PresioError extends Error {
  code: PresioErrorCode;
}

/** What a command's handler gets: Presio's buttons pass { file } (a button
 *  with "accept"), { menuItem } (a pick from its menu) or { slide } (a
 *  thumbnail's menu); keybindings and the palette pass {};
 *  presio.commands.execute passes the caller's args. */
type PresioCommandArgs = { file?: PresioFile; menuItem?: string; slide?: number; [key: string]: unknown } | null;

type PresioSurface = "background" | "panel" | "viewerSheet" | "viewer" | "slide";

interface Presio {
  /** The plugin API's major version this frame implements (the manifest's "presio"). */
  readonly apiVersion: 1;
  /** What the host can do. */
  readonly capabilities: PresioCapability[];
  supports(capability: PresioCapability): boolean;
  /** This plugin: its id comes from where it was loaded from ("alice/poll",
   *  "presio/timer"); baseUrl is its own folder, which relative URLs resolve against. */
  readonly plugin: { id: string; name: string; displayName: string; version: string; baseUrl: string };
  readonly surface: PresioSurface;
  /** Panel surface: the id of the panel (contributes.panels) this frame draws; else null. */
  readonly panel: string | null;
  readonly role: "presenter" | "audience";
  readonly theme: "light" | "dark";
  readonly session: { id: string; local: boolean; joinUrl: string | null };
  onContextChange(cb: (presio: Presio) => void): Unsubscribe;
  readonly slide: {
    readonly current: number;
    readonly total: number;
    onChange(cb: (slide: { current: number; total: number }) => void): Unsubscribe;
  };
  readonly messages: {
    /** retain: true for the session, "deck" until the deck is replaced; a
     *  retained null forgets the type. volatile: may be dropped, not queued. */
    send(type: string, payload?: unknown, opts?: { retain?: boolean | "deck"; volatile?: boolean }): void;
    onMessage(cb: (message: PresioMessage) => void): Unsubscribe;
  };
  readonly settings: {
    get(name: string): unknown;
    readonly all: Record<string, unknown>;
    set(name: string, value: unknown): Promise<void>;
    onChange(cb: (settings: Record<string, unknown>) => void): Unsubscribe;
  };
  readonly storage: {
    get(key: string): unknown;
    readonly all: Record<string, unknown>;
    set(key: string, value?: unknown): void;
    onChange(cb: (storage: Record<string, unknown>) => void): Unsubscribe;
  };
  readonly commands: {
    /** Handle one of this plugin's commands (contributes.commands) in this
     *  frame; what the handler returns is the command's result. */
    register(id: string, handler: (args: PresioCommandArgs) => unknown): Unsubscribe;
    /** Run a command on this device — "<plugin id>.<command>", a bare id for
     *  this plugin's own, or one of Presio's ("presio.nextSlide",
     *  "presio.prevSlide", "presio.firstSlide", "presio.lastSlide",
     *  "presio.goToSlide" with { slide }) — and get its result. */
    execute<T = unknown>(command: string, args?: unknown): Promise<T>;
    /** The presenter's key for one of this plugin's commands ("E", "⌘Z"),
     *  or null when it has none; a change calls onContextChange. */
    shortcut(id: string): string | null;
  };
  readonly deck: {
    attachments(): Promise<{ filename: string; bytes: Uint8Array }[]>;
    bytes(): Promise<Uint8Array>;
    /** Each page's size in PDF points, in page order. */
    pages(): Promise<{ width: number; height: number }[]>;
    save(bytes: Uint8Array): Promise<void>;
    /** "edit": the same pages edited in place; "replace": a different document. */
    onChange(cb: (kind: "edit" | "replace") => void): Unsubscribe;
    /** Transform the PDF this device downloads. */
    onExport(
      handler: (bytes: Uint8Array, info: { mode: "everything" | "no-attachments" }) => Uint8Array | Promise<Uint8Array>
    ): Unsubscribe;
  };
  readonly layers: {
    set(slide: number, items: PresioLayerItem[]): void;
    clear(): void;
  };
  readonly clock: { now(): number };
  /** The deck's edit history ("history" permission): open once per frame. */
  readonly history: {
    open<S, Op = unknown>(spec: PresioHistorySpec<S, Op>): PresioHistory<S, Op>;
  };
  /** Content-addressed bytes ("history"): put resolves to the SHA-256. */
  readonly blobs: {
    put(data: Blob | Uint8Array | ArrayBuffer): Promise<string>;
    get(sha: string): Promise<Blob | null>;
  };
  /** Each viewer's input ("audience" permission): one slot per viewer under
   *  each key the presenter opens. Values are JSON, at most 16 KB. */
  readonly audience: {
    /** Viewer: write this viewer's own value under an open key (null removes
     *  it). Rejects with "Unavailable" when the key is closed. */
    set(key: string, value: unknown): Promise<void>;
    /** Viewer: this viewer's own value under a key, or null. */
    get(key: string): unknown;
    state(key: string): { open: boolean };
    onState(cb: (e: { key: string; open: boolean }) => void): Unsubscribe;
    onState(key: string, cb: (e: { key: string; open: boolean }) => void): Unsubscribe;
    /** Viewer: this viewer's own value changed (cleared, or set by another surface). */
    onMine(cb: (e: { key: string; value: unknown }) => void): Unsubscribe;
    onMine(key: string, cb: (e: { key: string; value: unknown }) => void): Unsubscribe;
    /** Presenter: start, stop or reset taking viewers' values for a key. */
    open(key: string): Promise<void>;
    close(key: string): Promise<void>;
    clear(key: string): Promise<void>;
    /** Presenter: every viewer's value, by anonymous viewer id. */
    all(key: string): Promise<Record<string, unknown>>;
    /** Presenter: identical values counted, most common first. */
    summary(key: string): Promise<PresioAudienceSummary>;
    /** Presenter: viewers' values changed (a few times a second at most). */
    onChange(cb: (e: PresioAudienceChange) => void): Unsubscribe;
    onChange(key: string, cb: (e: PresioAudienceChange) => void): Unsubscribe;
  };
  readonly ui: {
    /** "viewer" surface: show or hide its layer. "viewerSheet": open or close
     *  its sheet (the viewer can close it too; see onVisibleChange). */
    setVisible(visible: boolean): void;
    /** Whether this frame's layer or sheet is showing. */
    readonly visible: boolean;
    /** It was shown or hidden, by the plugin or by the viewer closing the sheet. */
    onVisibleChange(cb: (visible: boolean) => void): Unsubscribe;
    /** A status item (contributes.status) in the controller's header; null or
     *  an empty text hides it. A click runs `command` with `args`. */
    setStatus(id: string, status: PresioStatus | null): void;
    setInteractive(value: boolean | "pen" | { x: number; y: number; w: number; h: number }[]): void;
    /** The state of the buttons that run a command; a menu pick runs it with { menuItem }. */
    setButton(command: string, state: { active?: boolean; label?: string; disabled?: boolean; menu?: PresioMenuEntry[] }): void;
    /** Slide surface: the part of it on screen (fractions of it) and its zoom. */
    readonly view: PresioView;
    onViewChange(cb: (view: PresioView) => void): Unsubscribe;
    /** Slide surface: where the page is within it (fractions of it) — all of
     *  it unless the manifest has "slideSurface": "area". */
    readonly page: { x: number; y: number; w: number; h: number };
    onPageChange(cb: (page: { x: number; y: number; w: number; h: number }) => void): Unsubscribe;
    /** Slide surface: whether a mouse is over the slide. */
    readonly hovered: boolean;
    onHover(cb: (hovered: boolean) => void): Unsubscribe;
  };
}

declare const presio: Presio;
