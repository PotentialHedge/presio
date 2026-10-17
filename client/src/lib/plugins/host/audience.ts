// presio.audience ("audience" permission): each viewer's input, one slot per
// viewer under each key a plugin opens. Viewers write their own slot; the
// presenter opens, closes and clears keys, reads every slot, and hears about
// changes in batches with a summary (counts of identical values).
//
// Where the slots live depends on the deck. For a shared deck the server holds
// them (server/audience.ts) and the presenter's page keeps a mirror, saved in
// this browser, that re-seeds the server after a restart. For a local deck the
// audience is the viewer window in this browser, over the BroadcastChannel,
// and the presenter's page holds the slots itself. usePluginHost supplies the
// transport (the link) and feeds in what arrives.

import { audienceViewerKey, lsGet, lsGetString, lsRemove, lsSet, lsSetString, pluginAudienceKey } from "@/lib/storage";
import {
  AUDIENCE_KEY_RE,
  AudienceSlots,
  ChangeBatcher,
  VIEWER_ID_RE,
  slotJson,
  type AudienceJoin,
  type AudienceKeyState,
  type AudienceSummary,
} from "@shared/plugin/audience";
import { HostError, type HostCore, type MethodTable, type Params } from "./types";

/** How the slots' holder is reached. Each rejects with the reason it refused. */
export interface AudienceLink {
  /** Presenter. */
  open?(plugin: string, key: string): Promise<void>;
  close?(plugin: string, key: string): Promise<void>;
  clear?(plugin: string, key: string): Promise<void>;
  /** Viewer: write this viewer's own slot (null removes it). */
  set?(plugin: string, key: string, value: unknown): Promise<void>;
}

/** What a frame starts from: each key's state, and (viewer) its own values. */
export interface AudienceFrameState {
  keys: Record<string, boolean>;
  mine: Record<string, unknown>;
}

/** How long changes wait before the presenter's copy is saved. */
const PERSIST_DELAY_MS = 500;

// The id when this browser can't keep one (private mode): this page's only.
const memoryIds = new Map<string, string>();

/** This browser's anonymous id among a session's viewers: kept for the
 *  session so a reload or reconnect writes the same slot. */
export function audienceViewerId(sessionId: string): string {
  const stored = lsGetString(audienceViewerKey(sessionId));
  if (VIEWER_ID_RE.test(stored)) return stored;
  let id = memoryIds.get(sessionId);
  if (!id) {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    id = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_");
    memoryIds.set(sessionId, id);
  }
  lsSetString(audienceViewerKey(sessionId), id);
  return id;
}

const keyOf = (p: Params, method: string): string => {
  if (typeof p.key !== "string" || !AUDIENCE_KEY_RE.test(p.key)) {
    throw new HostError("InvalidParams", `${method}: a key is 1–64 letters, digits or _ . : -`);
  }
  return p.key;
};

const failed = (e: unknown): HostError =>
  e instanceof HostError ? e : new HostError("Unavailable", e instanceof Error ? e.message : String(e));

export class Audience {
  private core: HostCore;
  private link: AudienceLink = {};
  // Presenter: every plugin's slots — the server's mirrored, or (local deck)
  // the only copy. Loaded from this browser for the session on first use.
  private slots = new Map<string, AudienceSlots>();
  private loadedFor: string | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  // Viewer: each plugin's key states and this viewer's own values.
  private viewer = new Map<string, AudienceFrameState>();
  // Local deck: the viewer window's writes, gathered before frames hear.
  private batcher = new ChangeBatcher((batch, changes) => {
    const [plugin, key] = batch.split("\u0000");
    this.changed(plugin, key, this.slotsOf(plugin).summary(key), changes);
  });

  constructor(core: HostCore) {
    this.core = core;
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", () => {
        if (this.persistTimer) this.persist();
      });
    }
  }

  private get presenter() {
    return this.core.ctx.role === "presenter";
  }

  private presenterOnly(method: string) {
    if (!this.presenter) throw new HostError("Unavailable", `${method} is the presenter's`);
  }

  readonly methods: MethodTable = {
    "audience.set": {
      permission: "audience",
      handler: async (conn, p) => {
        if (this.presenter) throw new HostError("Unavailable", "audience.set is a viewer's: the presenter has no slot of their own");
        const key = keyOf(p, "audience.set");
        const value = p.value === undefined ? null : p.value;
        if (value !== null) {
          const json = slotJson(value);
          if ("error" in json) throw new HostError("InvalidParams", json.error);
        }
        const plugin = conn.plugin.id;
        if (this.viewerState(plugin).keys[key] !== true) {
          throw new HostError("Unavailable", `"${key}" is closed: the presenter isn't taking answers to it`);
        }
        if (!this.link.set) throw new HostError("Unavailable", "Not connected to the presenter");
        try {
          await this.link.set(plugin, key, value);
        } catch (e) {
          throw failed(e);
        }
        this.setMine(plugin, key, value);
        return null;
      },
    },
    "audience.open": { permission: "audience", handler: (conn, p) => this.setOpen(conn.plugin.id, keyOf(p, "audience.open"), true) },
    "audience.close": { permission: "audience", handler: (conn, p) => this.setOpen(conn.plugin.id, keyOf(p, "audience.close"), false) },
    "audience.clear": {
      permission: "audience",
      handler: async (conn, p) => {
        this.presenterOnly("audience.clear");
        const plugin = conn.plugin.id;
        const key = keyOf(p, "audience.clear");
        if (!this.link.clear) throw new HostError("Unavailable", "Not connected to the session");
        try {
          await this.link.clear(plugin, key);
        } catch (e) {
          throw failed(e);
        }
        this.slotsOf(plugin).clear(key);
        this.schedulePersist();
        this.changed(plugin, key, { total: 0, values: [] }, {}, true);
        return null;
      },
    },
    "audience.all": {
      permission: "audience",
      handler: (conn, p) => {
        this.presenterOnly("audience.all");
        return this.slotsOf(conn.plugin.id).all(keyOf(p, "audience.all"));
      },
    },
    "audience.summary": {
      permission: "audience",
      handler: (conn, p) => {
        this.presenterOnly("audience.summary");
        return this.slotsOf(conn.plugin.id).summary(keyOf(p, "audience.summary"));
      },
    },
  };

  /** The transport to the slots' holder (none: calls fail as Unavailable). */
  setLink(link: AudienceLink | null) {
    this.link = link ?? {};
  }

  /** What a frame of this plugin starts from. */
  frameState(plugin: string): AudienceFrameState {
    if (this.presenter) return { keys: this.slotsOf(plugin).keyStates(), mine: {} };
    const state = this.viewerState(plugin);
    return { keys: { ...state.keys }, mine: { ...state.mine } };
  }

  // --- Presenter ---

  private async setOpen(plugin: string, key: string, open: boolean) {
    this.presenterOnly(open ? "audience.open" : "audience.close");
    const send = open ? this.link.open : this.link.close;
    if (!send) throw new HostError("Unavailable", "Not connected to the session");
    try {
      await send(plugin, key);
    } catch (e) {
      throw failed(e);
    }
    if (this.slotsOf(plugin).setOpen(key, open)) {
      this.schedulePersist();
      this.broadcast(plugin, "audience.state", { key, open });
    }
    return null;
  }

  /** Shared deck: a batch of viewers' writes, with the server's summary. */
  receiveUpdate(plugin: string, key: string, summary: AudienceSummary, changes: Record<string, unknown>) {
    if (!this.presenter || !AUDIENCE_KEY_RE.test(key)) return;
    const slots = this.slotsOf(plugin);
    for (const [viewer, value] of Object.entries(changes ?? {})) {
      if (VIEWER_ID_RE.test(viewer)) slots.put(key, viewer, value);
    }
    this.schedulePersist();
    this.changed(plugin, key, summary, changes ?? {});
  }

  /** Local deck: the viewer window wrote its slot. Returns why not, or null. */
  receiveWrite(plugin: string, key: string, viewer: string, value: unknown): string | null {
    if (!this.presenter) return "Not the presenter's window";
    if (typeof key !== "string" || !AUDIENCE_KEY_RE.test(key) || typeof viewer !== "string" || !VIEWER_ID_RE.test(viewer)) {
      return "Bad request";
    }
    const v = value === undefined ? null : value;
    const error = this.slotsOf(plugin).write(key, viewer, v);
    if (error) return error;
    this.schedulePersist();
    this.batcher.add(`${plugin}\u0000${key}`, viewer, v);
    return null;
  }

  /** Local deck: what the viewer window gets when it (re)joins. */
  joinFor(viewer: string): AudienceJoin {
    this.ensureLoaded();
    const out: AudienceJoin = {};
    for (const [plugin, slots] of this.slots) out[plugin] = { keys: slots.keyStates(), mine: slots.mine(viewer) };
    return out;
  }

  /** The mirror of one plugin's slots, to re-seed the server with. */
  mirrorOf(plugin: string): Record<string, AudienceKeyState> {
    return this.slotsOf(plugin).toJSON();
  }

  /** The server's copy of a plugin's slots after a re-seed: it's the newer. */
  adopt(plugin: string, keys: Record<string, AudienceKeyState>) {
    if (!this.presenter) return;
    const slots = this.slotsOf(plugin);
    const before = slots.keyStates();
    slots.replace(keys ?? {});
    this.schedulePersist();
    const after = slots.keyStates();
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (before[key] !== after[key]) this.broadcast(plugin, "audience.state", { key, open: after[key] === true });
      this.changed(plugin, key, slots.summary(key), {}, true);
    }
  }

  /** Viewers' values under a key changed: tell the plugin's frames here. */
  private changed(plugin: string, key: string, summary: AudienceSummary, changes: Record<string, unknown>, reset = false) {
    this.broadcast(plugin, "audience.change", { key, summary, changes, ...(reset ? { reset: true } : {}) });
  }

  private slotsOf(plugin: string): AudienceSlots {
    this.ensureLoaded();
    let slots = this.slots.get(plugin);
    if (!slots) {
      slots = new AudienceSlots();
      this.slots.set(plugin, slots);
    }
    return slots;
  }

  /** Load the presenter's saved copy for this session (again, if the session changed). */
  private ensureLoaded() {
    const session = this.core.ctx.session.id;
    if (!this.presenter || this.loadedFor === session) return;
    this.loadedFor = session;
    this.slots.clear();
    const saved = lsGet<unknown>(pluginAudienceKey(session), {});
    if (typeof saved !== "object" || saved === null) return;
    for (const [plugin, keys] of Object.entries(saved as Record<string, unknown>)) {
      if (typeof keys !== "object" || keys === null) continue;
      const slots = new AudienceSlots();
      slots.replace(keys as Record<string, AudienceKeyState>);
      this.slots.set(plugin, slots);
    }
  }

  private schedulePersist() {
    if (!this.presenter || this.persistTimer) return;
    this.persistTimer = setTimeout(() => this.persist(), PERSIST_DELAY_MS);
  }

  private persist() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    if (!this.presenter || !this.loadedFor) return;
    const all: Record<string, Record<string, AudienceKeyState>> = {};
    for (const [plugin, slots] of this.slots) {
      const keys = slots.toJSON();
      if (Object.keys(keys).length) all[plugin] = keys;
    }
    // Too big for this browser's storage: the server's copy still holds.
    if (Object.keys(all).length) lsSet(pluginAudienceKey(this.loadedFor), all);
    else lsRemove(pluginAudienceKey(this.loadedFor));
  }

  // --- Viewer ---

  private viewerState(plugin: string): AudienceFrameState {
    let state = this.viewer.get(plugin);
    if (!state) {
      state = { keys: {}, mine: {} };
      this.viewer.set(plugin, state);
    }
    return state;
  }

  private setMine(plugin: string, key: string, value: unknown) {
    const state = this.viewerState(plugin);
    if (value === null || value === undefined) delete state.mine[key];
    else state.mine[key] = value;
    this.broadcast(plugin, "audience.mine", { key, value: value ?? null });
  }

  /** (Re)joined: every plugin's key states and this viewer's values. */
  receiveJoin(join: AudienceJoin) {
    if (this.presenter) return;
    const plugins = new Set([...this.viewer.keys(), ...Object.keys(join ?? {})]);
    for (const plugin of plugins) {
      const before = this.viewerState(plugin);
      const next = join?.[plugin] ?? { keys: {}, mine: {} };
      this.viewer.set(plugin, { keys: { ...next.keys }, mine: { ...next.mine } });
      for (const key of new Set([...Object.keys(before.keys), ...Object.keys(next.keys)])) {
        const open = next.keys[key] === true;
        if ((before.keys[key] === true) !== open) this.broadcast(plugin, "audience.state", { key, open });
      }
      for (const key of new Set([...Object.keys(before.mine), ...Object.keys(next.mine)])) {
        const value = next.mine[key] ?? null;
        if (JSON.stringify(before.mine[key] ?? null) !== JSON.stringify(value)) this.broadcast(plugin, "audience.mine", { key, value });
      }
    }
  }

  /** The presenter opened or closed a key. */
  receiveKeyState(plugin: string, key: string, open: boolean) {
    if (this.presenter || typeof key !== "string") return;
    const state = this.viewerState(plugin);
    if (state.keys[key] === open) return;
    state.keys[key] = open;
    this.broadcast(plugin, "audience.state", { key, open });
  }

  /** The presenter cleared a key: this viewer's value under it is gone. */
  receiveCleared(plugin: string, key: string) {
    if (this.presenter || typeof key !== "string") return;
    if (key in this.viewerState(plugin).mine) this.setMine(plugin, key, null);
  }

  private broadcast(plugin: string, method: string, params: unknown) {
    for (const conn of this.core.framesOf(plugin)) this.core.emit(conn, method, params);
  }
}
