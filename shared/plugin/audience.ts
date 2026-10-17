// presio.audience: each viewer's input, one slot per viewer under each key a
// plugin opens. Shared by the two places that hold the slots: the server, for
// a shared deck (server/socket.ts), and the presenter's page, which mirrors
// them (and holds them itself for a local deck, whose audience is the viewer
// window in the same browser). Both summarize the same way, so a plugin sees
// the same counts either way.

import { MAX_MESSAGE_BYTES, MESSAGE_TYPE_RE } from "./protocol.js";

/** One viewer's value under one key, as JSON (the same cap as a message). */
export const MAX_SLOT_BYTES = MAX_MESSAGE_BYTES;
/** A key: what presio.audience.open's argument may be. */
export const AUDIENCE_KEY_RE = MESSAGE_TYPE_RE;
/** A viewer's anonymous id, as its browser makes it (see audienceViewerId). */
export const VIEWER_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** How long changes to a key gather before the presenter hears of them. */
export const AUDIENCE_FLUSH_MS = 250;

/** Identical values counted, most common first, and how many slots there are. */
export interface AudienceSummary {
  total: number;
  values: { value: unknown; count: number }[];
}

/** One key as it travels: whether it takes writes, and every viewer's value. */
export interface AudienceKeyState {
  open: boolean;
  slots: Record<string, unknown>;
}

/** What a (re)joining viewer gets back, per plugin: each key's state and its own values. */
export type AudienceJoin = Record<string, { keys: Record<string, boolean>; mine: Record<string, unknown> }>;

/** JSON with every object's keys sorted, so equal values read the same. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return v;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) sorted[k] = (v as Record<string, unknown>)[k];
    return sorted;
  });
}

const encoder = new TextEncoder();

/** A value's canonical JSON, or why it can't be a slot. */
export function slotJson(value: unknown): { canon: string } | { error: string } {
  let canon: string | undefined;
  try {
    canon = canonicalJson(value);
  } catch {
    return { error: "An audience value is JSON" };
  }
  if (canon === undefined) return { error: "An audience value is JSON" };
  if (encoder.encode(canon).length > MAX_SLOT_BYTES) return { error: `An audience value is at most ${MAX_SLOT_BYTES / 1024} KB as JSON` };
  return { canon };
}

interface Slot {
  value: unknown;
  canon: string;
}

interface Key {
  open: boolean;
  slots: Map<string, Slot>;
}

/** One plugin's keys and slots. */
export class AudienceSlots {
  private keys = new Map<string, Key>();

  private key(name: string): Key {
    let key = this.keys.get(name);
    if (!key) {
      key = { open: false, slots: new Map() };
      this.keys.set(name, key);
    }
    return key;
  }

  /** Open or close a key; returns whether that changed anything. */
  setOpen(name: string, open: boolean): boolean {
    const key = this.key(name);
    if (key.open === open) return false;
    key.open = open;
    return true;
  }

  isOpen(name: string): boolean {
    return this.keys.get(name)?.open ?? false;
  }

  /** Forget every viewer's value under a key (it stays open or closed). */
  clear(name: string) {
    this.keys.get(name)?.slots.clear();
  }

  /** Keep (or, for null, forget) one viewer's value. Doesn't check the key is open. */
  put(name: string, viewer: string, value: unknown, canon?: string) {
    const key = this.key(name);
    if (value === null || value === undefined) key.slots.delete(viewer);
    else key.slots.set(viewer, { value, canon: canon ?? canonicalJson(value) });
  }

  /** A viewer's write: null when it's kept, else why not. */
  write(name: string, viewer: string, value: unknown): string | null {
    if (!this.isOpen(name)) return `"${name}" is closed: the presenter isn't taking answers to it`;
    if (value === null || value === undefined) {
      this.put(name, viewer, null);
      return null;
    }
    const json = slotJson(value);
    if ("error" in json) return json.error;
    this.put(name, viewer, value, json.canon);
    return null;
  }

  summary(name: string): AudienceSummary {
    const slots = this.keys.get(name)?.slots;
    const counts = new Map<string, { value: unknown; count: number }>();
    for (const slot of slots?.values() ?? []) {
      const entry = counts.get(slot.canon);
      if (entry) entry.count++;
      else counts.set(slot.canon, { value: slot.value, count: 1 });
    }
    return { total: slots?.size ?? 0, values: [...counts.values()].sort((a, b) => b.count - a.count) };
  }

  /** Every viewer's value under a key, by viewer id. */
  all(name: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [viewer, slot] of this.keys.get(name)?.slots ?? []) out[viewer] = slot.value;
    return out;
  }

  /** Each key's open state. */
  keyStates(): Record<string, boolean> {
    return Object.fromEntries([...this.keys].map(([name, key]) => [name, key.open]));
  }

  /** One viewer's own values. */
  mine(viewer: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, key] of this.keys) {
      const slot = key.slots.get(viewer);
      if (slot) out[name] = slot.value;
    }
    return out;
  }

  /** Everything, for the wire or localStorage. */
  toJSON(): Record<string, AudienceKeyState> {
    return Object.fromEntries([...this.keys].map(([name]) => [name, { open: this.isOpen(name), slots: this.all(name) }]));
  }

  /**
   * Take in another copy (the presenter's mirror re-seeding a server that
   * restarted, or one read back from storage): keys this one lacks come in
   * whole; for the rest, this copy's open state and values win, and only the
   * viewers it has no value for are added. Returns whether anything changed.
   */
  merge(name: string, state: AudienceKeyState): boolean {
    let changed = false;
    if (!this.keys.has(name)) {
      this.key(name).open = state.open === true;
      changed = true;
    }
    const key = this.key(name);
    for (const [viewer, value] of Object.entries(state.slots ?? {})) {
      if (!VIEWER_ID_RE.test(viewer) || key.slots.has(viewer) || value === null) continue;
      const json = slotJson(value);
      if ("error" in json) continue;
      key.slots.set(viewer, { value, canon: json.canon });
      changed = true;
    }
    return changed;
  }

  /** Replace everything with another copy (the server's, which is newer). */
  replace(state: Record<string, AudienceKeyState>) {
    this.keys.clear();
    for (const [name, key] of Object.entries(state)) {
      if (AUDIENCE_KEY_RE.test(name) && typeof key === "object" && key !== null) this.merge(name, key);
    }
  }
}

/**
 * Viewers' writes to a key, gathered for AUDIENCE_FLUSH_MS and then handed on
 * in one go — so a room voting at once costs the presenter a few updates a
 * second, not one per vote. The latest value per viewer wins (null: removed).
 */
export class ChangeBatcher {
  private pending = new Map<string, Map<string, unknown>>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private flush: (batch: string, changes: Record<string, unknown>) => void;

  constructor(flush: (batch: string, changes: Record<string, unknown>) => void) {
    this.flush = flush;
  }

  add(batch: string, viewer: string, value: unknown) {
    const changes = this.pending.get(batch) ?? new Map<string, unknown>();
    changes.set(viewer, value ?? null);
    this.pending.set(batch, changes);
    if (this.timers.has(batch)) return;
    this.timers.set(
      batch,
      setTimeout(() => {
        const due = this.pending.get(batch);
        this.pending.delete(batch);
        this.timers.delete(batch);
        if (due) this.flush(batch, Object.fromEntries(due));
      }, AUDIENCE_FLUSH_MS)
    );
  }

  /** Drop what's waiting under batches that start with `prefix` (a session ending). */
  drop(prefix: string) {
    for (const [batch, timer] of this.timers) {
      if (!batch.startsWith(prefix)) continue;
      clearTimeout(timer);
      this.timers.delete(batch);
      this.pending.delete(batch);
    }
  }
}
