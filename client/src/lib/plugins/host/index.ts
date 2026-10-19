// The app side of the plugin bridge. One PluginHost per open presentation owns
// every mounted plugin frame's MessagePort: it boots frames, keeps them up to
// date (slide, session, theme), and answers their calls through a dispatch
// table built from namespace modules — messages, storage, settings, commands,
// deck, layers, history, ui, audience — each registering its methods with the
// permission they need (see dispatch.ts). The wire format is
// shared/plugin/protocol.ts.
//
// Everything a plugin does goes over its port. That's deliberate: a later move
// of plugin frames to an origin of their own only has to change how frames are
// loaded and how input is forwarded to them, not this.

import type { PdfAttachment } from "@/lib/pdf";
import { clockOffset } from "@/lib/clock";
import type { Keymap } from "@/lib/keymap";
import {
  PROTOCOL_VERSION,
  eventOf,
  isEnvelope,
  type BootMessage,
  type Capability,
  type CallEnvelope,
} from "@shared/plugin/protocol";
import type { LoadedPlugin, PluginSurface } from "../manifest";
import type { HistoryHub } from "../history";
import { Audience } from "./audience";
import { Commands, type AppCommandHandler } from "./commands";
import { Deck, type ExportMode, type PageSize } from "./deck";
import { dispatch } from "./dispatch";
import { History } from "./history";
import { Layers, type PluginLayer } from "./layers";
import { Messages, type WireEvent } from "./messages";
import { Settings } from "./settings";
import { Storage } from "./storage";
import {
  FULL_PAGE,
  FULL_VIEW,
  HostError,
  type Conn,
  type FrameHooks,
  type HostCore,
  type MethodTable,
  type PluginContext,
  type SlidePage,
  type SlideView,
} from "./types";
import { Ui, type ButtonState, type StatusState } from "./ui";
import { Viewers } from "./viewers";

export * from "./types";
export { retainKey, forgetDeckRetained, type Retain, type WireEvent } from "./messages";
export type { ButtonState, ButtonMenuEntry, StatusState } from "./ui";
export { APP_COMMAND_PREFIX, type AppCommandHandler } from "./commands";
export type { LayerItem, PluginLayer } from "./layers";
export type { DeckChange, ExportMode, PageSize } from "./deck";
export { audienceViewerId, type AudienceLink } from "./audience";

/** What this host implements (presio.supports()). */
export const HOST_CAPABILITIES: Capability[] = [
  "slide", "context", "settings", "storage", "messages", "commands", "deck", "layers", "history", "blobs", "clock", "ui", "panels",
  "audience", "status", "viewerSheet", "palette", "viewers",
];

/** A file the presenter picked for a button that asks for one. */
export interface ButtonFile {
  name: string;
  type: string;
  bytes: Uint8Array;
}

/** What the page tells one mounted frame about how it's shown. */
export interface FrameLink {
  disconnect(): void;
  setView(view: SlideView): void;
  setPage(page: SlidePage): void;
  setHovered(hovered: boolean): void;
  /** Presio showed or hid the frame's container itself (the viewer dismissed
   *  a sheet): the plugin hears it (presio.ui.onVisibleChange). */
  setVisible(visible: boolean): void;
}

/** A call this host made to a frame, waiting for its answer. */
interface PendingCall {
  conn: Conn;
  resolve(result: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class PluginHost implements HostCore {
  ctx: PluginContext;
  private conns = new Set<Conn>();
  private clock = clockOffset();
  // Running plugins in the presenter's order: the order exports apply in.
  private running: readonly string[] = [];
  private pending = new Map<number, PendingCall>();
  private nextCall = 1;

  private messages: Messages;
  private storage: Storage;
  private settings: Settings;
  private commands: Commands;
  private deck: Deck;
  private layers: Layers;
  private historyModule: History;
  private ui: Ui;
  /** presio.audience: viewers' input, and the way to wherever it's held. */
  readonly audience: Audience;
  /** presio.viewers: who runs which plugin (presenter), or what runs here (viewer). */
  readonly viewers: Viewers;
  private table: MethodTable;

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
    this.messages = new Messages(this);
    this.storage = new Storage(this);
    this.settings = new Settings(this);
    this.commands = new Commands(this);
    this.deck = new Deck(this);
    this.layers = new Layers();
    this.historyModule = new History(this);
    this.ui = new Ui(this);
    this.audience = new Audience(this);
    this.viewers = new Viewers(this);
    this.table = {
      ...this.messages.methods,
      ...this.storage.methods,
      ...this.settings.methods,
      ...this.commands.methods,
      ...this.deck.methods,
      ...this.layers.methods,
      ...this.historyModule.methods,
      ...this.ui.methods,
      ...this.audience.methods,
    };
  }

  private onPageHide = () => this.flush();

  /** Saves on pagehide while mounted; dispose() undoes it. */
  attach() {
    window.addEventListener("pagehide", this.onPageHide);
  }

  /** Unmounted: stop listening for the page going, and save what's pending. */
  dispose() {
    window.removeEventListener("pagehide", this.onPageHide);
    this.flush();
  }

  private flush() {
    this.messages.flush();
    this.audience.flush();
    this.history.flush();
  }

  /** Plugins' edit histories (presio.history), and the way to other devices'. */
  get history(): HistoryHub {
    return this.historyModule.hub;
  }

  get context(): PluginContext {
    return this.ctx;
  }

  // --- HostCore ---

  frames(): Iterable<Conn> {
    return this.conns;
  }

  framesOf(pluginId: string): Conn[] {
    return [...this.conns].filter((c) => c.plugin.id === pluginId);
  }

  emit(conn: Conn, method: string, params?: unknown) {
    conn.port.postMessage(eventOf(method, params));
  }

  call<T>(conn: Conn, method: string, params: unknown, timeoutMs: number): Promise<T> {
    const id = this.nextCall++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HostError("Unavailable", `The plugin didn't answer ${method} in time`));
      }, timeoutMs);
      this.pending.set(id, { conn, resolve: resolve as (r: unknown) => void, reject, timer });
      const message: CallEnvelope = { v: PROTOCOL_VERSION, kind: "call", id, method, params };
      conn.port.postMessage(message);
    });
  }

  // --- Context ---

  updateContext(next: PluginContext) {
    const prev = this.ctx;
    this.ctx = next;
    this.history.setDeck(next.session.id);
    this.history.setPresenter(next.role === "presenter");
    const slideChanged = prev.slide.current !== next.slide.current || prev.slide.total !== next.slide.total;
    const otherChanged =
      prev.role !== next.role ||
      prev.theme !== next.theme ||
      prev.session.id !== next.session.id ||
      prev.session.local !== next.session.local ||
      prev.session.joinUrl !== next.session.joinUrl;
    for (const conn of this.conns) {
      if (otherChanged) this.emit(conn, "context.change", { context: this.frameContext(conn.plugin, conn.surface, conn.panel) });
      else if (slideChanged) this.emit(conn, "slide.change", { slide: next.slide });
    }
  }

  /** What a frame starts from; also re-sent whole when the session or role changes. */
  private frameContext(plugin: LoadedPlugin, surface: PluginSurface, panel?: string) {
    const { manifest } = plugin;
    return {
      plugin: { id: plugin.id, name: manifest.name, displayName: manifest.displayName, version: manifest.version, baseUrl: plugin.baseUrl },
      surface,
      panel: panel ?? null,
      ...this.ctx,
      settings: this.settings.of(plugin.id),
      storage: this.storage.read(plugin.id),
      audience: this.audience.frameState(plugin.id),
      viewers: this.viewers.of(plugin.id),
      clockOffset: this.clock,
      shortcuts: this.commands.shortcuts(plugin),
      view: FULL_VIEW,
      page: FULL_PAGE,
      hovered: false,
    };
  }

  /** The handshake a frame boots from (posted with its port, see PluginFrame). */
  bootMessage(plugin: LoadedPlugin, surface: PluginSurface, panel?: string): BootMessage {
    return {
      type: "presio:boot",
      protocol: PROTOCOL_VERSION,
      capabilities: HOST_CAPABILITIES,
      context: this.frameContext(plugin, surface, panel),
      html: plugin.html,
    };
  }

  /** The presenter's keyboard shortcuts changed (presio.commands.shortcut). */
  setKeymap(keymap: Keymap) {
    this.commands.setKeymap(keymap);
  }

  /** The server clock moved (lib/clock.ts); frames keep their own copy. */
  setClockOffset(offset: number) {
    if (Math.abs(offset - this.clock) < 1) return;
    this.clock = offset;
    for (const conn of this.conns) this.emit(conn, "clock.offset", { offset });
  }

  /** The plugins running now, in order; forgets the layers of any others. */
  setRunning(pluginIds: readonly string[]) {
    this.running = pluginIds;
    this.layers.keepOnly(pluginIds);
    this.ui.keepOnly(pluginIds);
  }

  /** A plugin's resolved settings changed (or arrived from the presenter). */
  setPluginSettings(pluginId: string, values: Record<string, unknown>) {
    this.settings.set(pluginId, values);
  }

  // --- The deck ---

  setDeckSource(
    attachments: () => Promise<PdfAttachment[]>,
    bytes: () => Promise<Uint8Array | null>,
    pages: () => Promise<PageSize[]>
  ) {
    if (!this.deck.setSource(attachments, bytes, pages)) return;
    // Histories are the deck's: one with a different page count is a
    // different document (see HistoryHub.setPages).
    void pages().then(
      (sizes) => { if (sizes.length && this.deck.bytesReader === bytes) this.history.setPages(sizes.length); },
      () => {}
    );
  }

  expectDeckEdit() {
    this.deck.expectEdit();
  }

  setDeckWriter(save: ((bytes: Uint8Array) => Promise<void>) | null) {
    this.deck.setWriter(save);
  }

  /** Pass a PDF this device downloads through the running plugins' export handlers. */
  exportDeck(bytes: Uint8Array, mode: ExportMode): Promise<Uint8Array> {
    return this.deck.export(bytes, mode, this.running);
  }

  // --- Static layers ---

  slideLayers(slide: number): PluginLayer[] {
    return this.layers.slideLayers(slide);
  }

  subscribeLayers = (listener: () => void) => this.layers.subscribe(listener);

  // --- Commands and the buttons that run them ---

  buttonStates(pluginId: string): Record<string, ButtonState> {
    return this.ui.buttonStates(pluginId);
  }

  subscribeButtons = (listener: () => void) => this.ui.subscribeButtons(listener);

  /** The presenter pressed a plugin's button: run its command, with the file
   *  picked for a button that asks for one. */
  pressButton(pluginId: string, command: string, file?: ButtonFile) {
    this.commands.run(pluginId, command, file ? { file } : {});
  }

  /** The presenter picked an item from a button's menu: its command runs with it. */
  pickMenuItem(pluginId: string, command: string, menuItem: string) {
    this.commands.run(pluginId, command, { menuItem });
  }

  /** Run a plugin's command from Presio's interface (a keybinding, the
   *  palette, a thumbnail's menu — which passes { slide }). */
  runCommand(pluginId: string, command: string, args: Record<string, unknown> = {}) {
    this.commands.run(pluginId, command, args);
  }

  /** Run a plugin's command and get its result (tests). */
  executeCommand(pluginId: string, command: string, args?: unknown): Promise<unknown> {
    return this.commands.execute(pluginId, command, args);
  }

  /** Presio's own commands, which plugins may run as "presio.<id>" (the
   *  exposed ones). Looked up on each call. */
  setAppCommands(lookup: (id: string) => AppCommandHandler | undefined) {
    this.commands.setAppCommands(lookup);
  }

  /** Whether a frame on this device handles one of a plugin's commands: the
   *  palette lists only those. */
  isCommandRegistered(pluginId: string, command: string): boolean {
    return this.commands.isRegistered(pluginId, command);
  }

  /** Changes whenever frames register or drop commands (for useSyncExternalStore). */
  commandRegistrations = () => this.commands.registrations;

  subscribeCommands = (listener: () => void) => this.commands.subscribe(listener);

  // --- Status items ---

  statusItems(pluginId: string): Record<string, StatusState> {
    return this.ui.statusItems(pluginId);
  }

  /** Changes whenever any plugin's status items do (for useSyncExternalStore). */
  statusRevision = () => this.ui.statusRevision;

  subscribeStatus = (listener: () => void) => this.ui.subscribeStatus(listener);

  // --- Messages between devices ---

  setOutbound(send: (event: WireEvent) => void) {
    this.messages.setOutbound(send);
  }

  receive(event: WireEvent) {
    this.messages.receive(event);
  }

  seedRetained(events: WireEvent[]) {
    this.messages.seedRetained(events);
  }

  forgetDeckRetained() {
    this.messages.forgetDeckRetained();
  }

  retainedEvents(): WireEvent[] {
    return this.messages.retainedEvents();
  }

  // --- Frames ---

  /**
   * Attach a mounted frame. The caller transfers the other end of `port` to
   * the frame with bootMessage(). Retained messages are replayed so a frame
   * that mounts late starts from the current state.
   */
  connect(plugin: LoadedPlugin, surface: PluginSurface, port: MessagePort, hooks: FrameHooks = {}, panel?: string): FrameLink {
    const conn: Conn = { plugin, surface, panel, port, ...hooks, commands: new Set(), exporter: false, history: false, snapshots: false };
    this.conns.add(conn);
    port.onmessage = (e) => this.onFrameMessage(conn, e.data);
    this.messages.replay(conn);
    this.viewers.framesChanged();
    let view = FULL_VIEW;
    let page = FULL_PAGE;
    let hovered = false;
    return {
      disconnect: () => {
        this.conns.delete(conn);
        port.close();
        this.viewers.framesChanged();
        if (conn.commands.size) this.commands.changed();
        // Calls to it won't be answered now.
        for (const [id, call] of this.pending) {
          if (call.conn !== conn) continue;
          clearTimeout(call.timer);
          this.pending.delete(id);
          call.reject(new HostError("Unavailable", "The plugin's frame closed"));
        }
      },
      setView: (next) => {
        if (next.x === view.x && next.y === view.y && next.w === view.w && next.h === view.h && next.scale === view.scale) return;
        view = next;
        this.emit(conn, "ui.view", { view });
      },
      setPage: (next) => {
        if (next.x === page.x && next.y === page.y && next.w === page.w && next.h === page.h) return;
        page = next;
        this.emit(conn, "ui.page", { page });
      },
      setHovered: (next) => {
        if (next === hovered) return;
        hovered = next;
        this.emit(conn, "ui.hover", { hovered });
      },
      setVisible: (visible) => this.emit(conn, "ui.visible", { visible }),
    };
  }

  private onFrameMessage(conn: Conn, data: unknown) {
    if (!isEnvelope(data)) return;
    switch (data.kind) {
      case "call":
        if (typeof data.id !== "number") return;
        void dispatch(this.table, conn, data).then((reply) => {
          if (this.conns.has(conn)) conn.port.postMessage(reply);
        });
        return;
      case "result":
      case "error": {
        const call = this.pending.get(data.id);
        if (!call || call.conn !== conn) return;
        this.pending.delete(data.id);
        clearTimeout(call.timer);
        if (data.kind === "result") call.resolve(data.result);
        else call.reject(new HostError(data.error?.code ?? "Internal", data.error?.message ?? "The plugin failed"));
        return;
      }
      case "event": {
        if (data.method === "frame.ready") conn.onReady?.();
        const height = (data.params as { height?: unknown } | undefined)?.height;
        if (data.method === "ui.contentSize" && typeof height === "number" && Number.isFinite(height)) {
          conn.onContentSize?.(Math.max(0, height));
        }
        return;
      }
    }
  }
}
