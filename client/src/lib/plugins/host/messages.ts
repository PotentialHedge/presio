// presio.messages: a plugin's messages to its other instances — its other
// frames on this page, and through a transport (socket or BroadcastChannel,
// see usePluginHost) its frames on other devices. The presenter's "retained"
// messages are the plugins' shared state: kept for devices that join later,
// and across a reload of the presenter's page.

import { lsGet, lsRemove, lsSet, pluginRetainedKey } from "@/lib/storage";
import { MESSAGE_TYPE_RE, VIEWER_ADDRESS_RE } from "@shared/plugin/protocol";
import { HostError, type Conn, type HostCore, type MethodTable, type PluginRole } from "./types";

export type Retain = boolean | "deck";

/** A plugin message as it travels between devices. */
export interface WireEvent {
  plugin: string;
  type: string;
  payload: unknown;
  /** Kept for devices that join later: for the session, or ("deck") only
   *  until the deck is replaced. */
  retain?: Retain;
  /** May be dropped rather than queued (a stream where only the latest counts). */
  volatile?: boolean;
  from?: PluginRole;
  sender?: string;
  /** From the presenter, for this one viewer only (presio.viewers' id). */
  to?: string;
}

/**
 * What one plugin may keep retained: this many message types, this many bytes
 * of payload (as JSON) — the server's caps (server/validation.ts). A drawing
 * keeps its strokes this way, a slide's worth per message; 2 MB is several
 * hundred thousand compactly encoded points.
 */
const MAX_RETAINED_PER_PLUGIN = 1024;
const MAX_RETAINED_BYTES_PER_PLUGIN = 2 * 1024 * 1024;
/** How long retained changes wait before the presenter's copy is saved. */
const PERSIST_DELAY_MS = 300;

/** A retained message's identity: its plugin and type (a later one replaces it). */
export const retainKey = ({ plugin, type }: Pick<WireEvent, "plugin" | "type">) => `${plugin}\u0000${type}`;

export class Messages {
  private core: HostCore;
  private retained = new Map<string, WireEvent>();
  // Each retained payload's size (JSON), for the per-plugin budget.
  private retainedSize = new Map<string, number>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private outbound: (event: WireEvent) => void = () => {};

  constructor(core: HostCore) {
    this.core = core;
    // The presenter's retained messages outlive a reload of their page: they
    // are the plugins' shared state (what's drawn, what's showing), and after
    // a server restart they're what the session is re-seeded from.
    if (core.ctx.role === "presenter") {
      const saved = lsGet<unknown>(pluginRetainedKey(core.ctx.session.id), []);
      for (const event of Array.isArray(saved) ? saved : []) {
        const e = event as Partial<WireEvent>;
        if (typeof e?.plugin === "string" && typeof e.type === "string" && e.payload !== undefined) {
          this.keepRetained({ plugin: e.plugin, type: e.type, payload: e.payload, retain: e.retain === "deck" ? "deck" : true, from: "presenter" });
        }
      }
      // Restoring isn't a change to save.
      if (this.persistTimer) clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    // Changes not yet saved when the page goes: save them now. Only this
    // host's own changes — a host that never changed anything (React may
    // build one it then discards) mustn't overwrite what another saved.
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", () => {
        if (this.persistTimer) this.persistRetained();
      });
    }
  }

  readonly methods: MethodTable = {
    "messages.send": {
      handler: (conn, p) => {
        if (typeof p.type !== "string" || !MESSAGE_TYPE_RE.test(p.type)) {
          throw new HostError("InvalidParams", "A message type is 1–64 letters, digits or _ . : -");
        }
        const role = this.core.ctx.role;
        if (p.to !== undefined) {
          if (typeof p.to !== "string" || !VIEWER_ADDRESS_RE.test(p.to)) throw new HostError("InvalidParams", "`to` is a viewer's id, from presio.viewers");
          if (role !== "presenter") throw new HostError("Unavailable", "Only the presenter can message one viewer: the audience's messages go to the presenter");
          if (p.retain) throw new HostError("InvalidParams", "A message for one viewer can't be retained");
          // Straight to that viewer: none of this device's frames are it.
          this.outbound({ plugin: conn.plugin.id, type: p.type, payload: p.payload ?? null, volatile: p.volatile === true, from: role, to: p.to });
          return null;
        }
        const event: WireEvent = {
          plugin: conn.plugin.id,
          type: p.type,
          payload: p.payload ?? null,
          retain: role === "presenter" && (p.retain === true || p.retain === "deck") ? p.retain : false,
          volatile: p.volatile === true,
          from: role,
        };
        if (event.retain) this.keepRetained(event);
        // The plugin's other frames on this page, then everyone else.
        for (const other of this.core.framesOf(event.plugin)) {
          if (other !== conn) this.deliver(other, event);
        }
        this.outbound(event);
        return null;
      },
    },
  };

  /** Where this device's outgoing messages go (the transport). */
  setOutbound(send: (event: WireEvent) => void) {
    this.outbound = send;
  }

  /** A frame connected: replay the retained state, so one that mounts late
   *  (a phone joining mid-talk) starts from the current state. */
  replay(conn: Conn) {
    for (const event of this.retained.values()) {
      if (event.plugin === conn.plugin.id) this.deliver(conn, event);
    }
  }

  /** A message from another device. */
  receive(event: WireEvent) {
    if (event.retain && event.from === "presenter") this.keepRetained(event);
    for (const conn of this.core.framesOf(event.plugin)) this.deliver(conn, event);
  }

  /** Retained messages from the server's snapshot, for a device (re)joining. */
  seedRetained(events: WireEvent[]) {
    for (const event of events) this.receive({ ...event, retain: event.retain === "deck" ? "deck" : true, from: "presenter" });
  }

  /** The deck was replaced: forget what was retained for it (retain: "deck"). */
  forgetDeckRetained() {
    for (const [key, event] of this.retained) {
      if (event.retain !== "deck") continue;
      this.retained.delete(key);
      this.retainedSize.delete(key);
    }
    this.schedulePersist();
  }

  retainedEvents(): WireEvent[] {
    return [...this.retained.values()];
  }

  private deliver(conn: Conn, event: WireEvent) {
    this.core.emit(conn, "messages.receive", {
      type: event.type,
      payload: event.payload,
      from: event.from ?? "presenter",
      sender: event.sender,
    });
  }

  /**
   * Keep (or, for a null payload, forget) a retained message, within the
   * plugin's budget. Returns whether it's kept. Over budget, the message still
   * goes out live; it just isn't there for devices that join later.
   */
  private keepRetained(event: WireEvent): boolean {
    const key = retainKey(event);
    if (event.payload === null) {
      this.retained.delete(key);
      this.retainedSize.delete(key);
      this.schedulePersist();
      return false;
    }
    let size: number;
    try {
      size = JSON.stringify(event.payload).length;
    } catch {
      return false;
    }
    let count = 0;
    let bytes = 0;
    for (const [k, e] of this.retained) {
      if (e.plugin !== event.plugin || k === key) continue;
      count++;
      bytes += this.retainedSize.get(k) ?? 0;
    }
    if (count >= MAX_RETAINED_PER_PLUGIN || bytes + size > MAX_RETAINED_BYTES_PER_PLUGIN) {
      console.warn(`Plugin "${event.plugin}" is over its retained budget; "${event.type}" won't reach late joiners`);
      return false;
    }
    this.retained.set(key, { plugin: event.plugin, type: event.type, payload: event.payload, retain: event.retain || true, from: "presenter" });
    this.retainedSize.set(key, size);
    this.schedulePersist();
    return true;
  }

  private schedulePersist() {
    if (this.core.ctx.role !== "presenter" || this.persistTimer) return;
    this.persistTimer = setTimeout(() => this.persistRetained(), PERSIST_DELAY_MS);
  }

  /** Save the presenter's retained messages for this session (see the constructor). */
  private persistRetained() {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    if (this.core.ctx.role !== "presenter") return;
    const key = pluginRetainedKey(this.core.ctx.session.id);
    const events = [...this.retained.values()].map(({ plugin, type, payload, retain }) => ({ plugin, type, payload, retain }));
    if (events.length) lsSet(key, events);
    else lsRemove(key);
  }
}

/** A deck replaced while its presenter's page wasn't open (from Home): forget
 *  the retained messages saved for it that belonged to the old deck. */
export function forgetDeckRetained(sessionId: string) {
  const key = pluginRetainedKey(sessionId);
  const saved = lsGet<unknown>(key, []);
  if (!Array.isArray(saved)) return;
  const kept = saved.filter((e) => (e as Partial<WireEvent>)?.retain !== "deck");
  if (kept.length) lsSet(key, kept);
  else lsRemove(key);
}
