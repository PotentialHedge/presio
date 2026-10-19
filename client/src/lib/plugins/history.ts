// Plugin histories (presio.history), the app side: each plugin's ordered log
// of edits to the deck, kept in step across the plugin's frames on this page
// and every other device in the session.
//
// A plugin commits ops; something puts them in one order — the server while a
// deck is shared (server/history.ts), this page for a local deck — and every
// device applies the same entries in the same order to the same starting
// point, so every copy of the plugin's state comes out the same. Until its op
// comes back ordered, a commit is "pending": shown at once on this device, on
// top of the ordered entries.
//
// The presenter's copy lasts: it's saved in IndexedDB (historyDb.ts) per deck
// and plugin, and it's what the session starts from when the deck is shared.
// Big things — snapshots of a plugin's state, which let the log start later
// than the beginning, and whatever else a plugin stores — are blobs, fetched
// only when asked for and never through the session's socket.

import { sha256Hex } from "@/lib/analytics";
import * as db from "./historyDb";

export interface HistoryEntry {
  seq: number;
  id: string;
  by: string;
  at: number;
  op: unknown;
  hash: string;
}

export interface HistoryBase {
  seq: number;
  hash: string;
  /** The snapshot blob the log starts from, or null for the plugin's init(). */
  snapshot: string | null;
}

export interface PendingOp {
  id: string;
  by: string;
  op: unknown;
}

/** One plugin's history for one deck, as saved. */
export interface HistoryLog {
  base: HistoryBase;
  entries: HistoryEntry[];
  pending: PendingOp[];
  /** The deck's page count it was made on: a deck with another count is a
   *  different document, and starts a fresh history. */
  pages: number | null;
}

export type SyncReply =
  | { kind: "empty" }
  | { kind: "current" }
  | { kind: "tail"; entries: HistoryEntry[] }
  | { kind: "reset"; base: HistoryBase; entries: HistoryEntry[] };

/** What goes to a plugin's frames. */
export type HistoryFrameMessage =
  | { kind: "state"; base: HistoryBase; snapshot: unknown; entries: HistoryEntry[]; pending: PendingOp[]; device: string }
  | { kind: "entry"; entry: HistoryEntry; pending: PendingOp[] }
  | { kind: "pending"; pending: PendingOp[] }
  | { kind: "error"; id: string; error: string };

/** How this device reaches the others. */
export interface HistoryLink {
  /** This device orders edits itself (a local deck's presenter). Otherwise
   *  `commit` does, and pending ops wait while there's no link. */
  ordersHere?: boolean;
  /** Catch up from whoever orders edits, given the head this device has. */
  sync?(plugin: string, head: { seq: number; hash: string }): Promise<SyncReply>;
  /** Have an op ordered; resolves to an error message, or null once accepted. */
  commit?(plugin: string, op: PendingOp): Promise<string | null>;
  /** Start the other side's history from this device's (it has none). */
  seed?(plugin: string, log: HistoryLog): Promise<boolean>;
  /** The log may start from this snapshot now. */
  snapshot?(plugin: string, base: HistoryBase): Promise<boolean>;
  /** Start a plugin's history afresh everywhere. */
  reset?(plugin: string): void;
  /** This device ordered an entry: pass it on. */
  publish?(plugin: string, entry: HistoryEntry): void;
  /** This device's copy of a history has loaded (followers may catch up). */
  loaded?(plugin: string): void;
  /** Make a blob available to the other devices. */
  uploadBlob?(sha: string, blob: Blob): Promise<void>;
  /** A blob this device doesn't have. */
  fetchBlob?(sha: string): Promise<Blob | null>;
}

export const EMPTY_BASE: HistoryBase = { seq: 0, hash: "", snapshot: null };

export const MAX_BLOB_BYTES = 5 * 1024 * 1024;
/** One op, as JSON: the size of a plugin message. */
export const MAX_OP_BYTES = 16 * 1024;
// When the presenter's device asks a plugin for a snapshot, so the log can
// start there: this many entries, or this much of them, since the last one.
const SNAPSHOT_ENTRIES = 200;
const SNAPSHOT_BYTES = 256 * 1024;
// Saved as soon as it changes (a burst of changes in one go is one save): for
// a local deck this copy is the only one, and a reload mustn't lose an edit.
const SAVE_DELAY_MS = 0;

export function entryHash(prev: string, id: string, op: unknown): Promise<string> {
  return sha256Hex(new TextEncoder().encode(`${prev}\n${id}\n${JSON.stringify(op)}`).buffer as ArrayBuffer);
}

export async function blobSha(blob: Blob): Promise<string> {
  return sha256Hex(await blob.arrayBuffer());
}

const newId = () => {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => (b % 36).toString(36)).join("");
};

/** This browser's id in histories (`by`): what "my last edit" means for undo. */
export function deviceId(): string {
  const key = "presio_device_id";
  try {
    let id = localStorage.getItem(key);
    if (!id || !/^[a-z0-9]{8,32}$/.test(id)) {
      id = newId();
      localStorage.setItem(key, id);
    }
    return id;
  } catch {
    return newId();
  }
}

interface PluginHistory {
  log: HistoryLog;
  /** The snapshot's content, once read; undefined until then. */
  snapshot: unknown;
  /** Loaded (from IndexedDB, and its snapshot read): frames can be told. */
  ready: boolean;
  loading: Promise<void> | null;
  /** Catching up: entries that arrive meanwhile wait here. */
  syncing: boolean;
  held: HistoryEntry[];
  snapshotting: boolean;
  /** Commits handed to the link and not yet heard back on. */
  inFlight: Set<string>;
}

export interface HistoryHubOptions {
  /** The deck's presentation id: whose histories these are. */
  deck: string;
  /** The presenter's device: it commits, keeps the lasting copy, snapshots. */
  presenter: boolean;
  /** Tell a plugin's frames. */
  deliver(plugin: string, message: HistoryFrameMessage): void;
  /** Ask one of a plugin's frames for a snapshot of its ordered state:
   *  { seq, data } for the entry it's at, or null when it can't. */
  requestSnapshot(plugin: string): Promise<{ seq: number; data: unknown } | null>;
}

export class HistoryHub {
  readonly device = deviceId();
  private histories = new Map<string, PluginHistory>();
  private link: HistoryLink = {};
  private linked = false;
  private pages: number | null = null;
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private blobCache = new Map<string, Promise<Blob | null>>();
  // Ordering here is async (hashing): one entry at a time.
  private ordering: Promise<void> = Promise.resolve();
  private opts: HistoryHubOptions;

  constructor(opts: HistoryHubOptions) {
    this.opts = opts;
  }

  /** Saves what's still waiting on its timer (the page is going). */
  flush() {
    for (const plugin of [...this.saveTimers.keys()]) this.save(plugin);
  }

  /** The deck's id changed (it was shared); its saved histories moved with it. */
  setDeck(deck: string) {
    this.opts.deck = deck;
  }

  /** This device holds the controls (or no longer does). */
  setPresenter(presenter: boolean) {
    this.opts.presenter = presenter;
  }

  /**
   * The way to the other devices. `ready` once it can be used (the socket
   * joined): every open history catches up, and resends what's pending.
   */
  setLink(link: HistoryLink, ready: boolean) {
    this.link = link;
    this.linked = ready;
    if (!ready) {
      for (const h of this.histories.values()) h.inFlight.clear();
      return;
    }
    for (const plugin of this.histories.keys()) void this.catchUp(plugin);
  }

  /** The deck's page count, once known: a history made on another count is
   *  for a different document and starts afresh. */
  setPages(pages: number) {
    this.pages = pages;
    if (!this.opts.presenter) return;
    for (const [plugin, h] of this.histories) {
      if (!h.ready) continue;
      if (h.log.pages !== null && h.log.pages !== pages && !isEmpty(h.log)) this.reset(plugin);
      else if (h.log.pages !== pages) {
        h.log.pages = pages;
        this.scheduleSave(plugin);
      }
    }
  }

  // --- Frames ---

  /** A frame opened the plugin's history: load it, then tell its frames. */
  open(plugin: string) {
    const h = this.history(plugin);
    if (h.ready) this.opts.deliver(plugin, this.stateMessage(h));
    else void this.load(plugin);
  }

  /**
   * A frame of the plugin (on the presenter's device) committed an op, under
   * an id it made (so it can show the op at once). Returns why it was
   * refused, or null.
   */
  commit(plugin: string, id: string, op: unknown): string | null {
    if (!this.opts.presenter) return "Only the presenter can change the history";
    let size: number;
    try {
      size = JSON.stringify(op)?.length ?? 0;
    } catch {
      return "An op has to be JSON";
    }
    if (op === undefined || op === null || !size) return "An op can't be empty";
    if (size > MAX_OP_BYTES) return `An op is at most ${MAX_OP_BYTES / 1024} KB of JSON`;
    const h = this.history(plugin);
    if (h.log.pending.some((p) => p.id === id) || h.log.entries.some((e) => e.id === id)) return "That op id is taken";
    const pending: PendingOp = { id, by: this.device, op };
    h.log.pending.push(pending);
    this.opts.deliver(plugin, { kind: "pending", pending: h.log.pending });
    this.scheduleSave(plugin);
    if (h.ready && !h.syncing) void this.send(plugin, pending);
    return null;
  }

  // --- Blobs ---

  /** Keep bytes as a blob; resolves to its hash (its address). */
  async putBlob(blob: Blob): Promise<string> {
    if (!this.opts.presenter) throw new Error("Only the presenter can add blobs");
    if (blob.size > MAX_BLOB_BYTES) throw new Error(`A blob is at most ${MAX_BLOB_BYTES / 1024 / 1024} MB`);
    const sha = await blobSha(blob);
    await db.putBlob(sha, blob);
    this.blobCache.set(sha, Promise.resolve(blob));
    await this.link.uploadBlob?.(sha, blob);
    return sha;
  }

  /**
   * A blob's bytes: this device's copy, else fetched — only now, when asked
   * for, and never on the socket, so a big one holds nothing else up.
   */
  getBlob(sha: string): Promise<Blob | null> {
    let cached = this.blobCache.get(sha);
    if (!cached) {
      cached = (async () => {
        const local = await db.getBlob(sha).catch(() => null);
        if (local) return local;
        const fetched = (await this.link.fetchBlob?.(sha)) ?? null;
        // The presenter keeps what it fetched (a blob another controller added).
        if (fetched && this.opts.presenter) void db.putBlob(sha, fetched).catch(() => {});
        return fetched;
      })();
      this.blobCache.set(sha, cached);
      // A miss (not uploaded yet, offline) is asked again next time.
      void cached.then((b) => {
        if (!b && this.blobCache.get(sha) === cached) this.blobCache.delete(sha);
      });
    }
    return cached;
  }

  // --- From the other devices ---

  /** An ordered entry (from the server, or the presenter's window). */
  receive(plugin: string, entry: HistoryEntry) {
    const h = this.histories.get(plugin);
    if (!h) return;
    if (!h.ready || h.syncing) {
      h.held.push(entry);
      return;
    }
    const top = headOf(h.log);
    if (entry.seq <= top.seq) {
      // Seen already — unless it isn't the entry this device has there: then
      // this device is on another line of history and has to catch up.
      const mine = h.log.entries.find((e) => e.seq === entry.seq);
      if (mine && mine.hash !== entry.hash) void this.catchUp(plugin);
      return;
    }
    // A gap: this device missed something (a dropped connection).
    if (entry.seq !== top.seq + 1) {
      h.held.push(entry);
      void this.catchUp(plugin);
      return;
    }
    this.append(plugin, h, entry);
  }

  /** The plugin's history was started afresh elsewhere: catch up from scratch. */
  receiveReset(plugin: string) {
    const h = this.histories.get(plugin);
    if (!h) return;
    h.log = { ...h.log, base: EMPTY_BASE, entries: [] };
    h.snapshot = null;
    this.scheduleSave(plugin);
    if (h.ready) this.opts.deliver(plugin, this.stateMessage(h));
    void this.catchUp(plugin);
  }

  /** A follower (a local deck's viewer window) asks what it's missing. */
  answerSync(plugin: string, head: { seq: number; hash: string }): SyncReply {
    const h = this.histories.get(plugin);
    if (!h?.ready || isEmpty(h.log)) return { kind: "empty" };
    const { base, entries } = h.log;
    const top = headOf(h.log);
    if (head.seq === top.seq && head.hash === top.hash) return { kind: "current" };
    const known = (head.seq === base.seq && head.hash === base.hash) || entries.some((e) => e.seq === head.seq && e.hash === head.hash);
    if (known) return { kind: "tail", entries: entries.filter((e) => e.seq > head.seq) };
    return { kind: "reset", base, entries };
  }

  // --- Internals ---

  private history(plugin: string): PluginHistory {
    let h = this.histories.get(plugin);
    if (!h) {
      h = {
        log: { base: EMPTY_BASE, entries: [], pending: [], pages: this.pages },
        snapshot: null,
        ready: false,
        loading: null,
        syncing: false,
        held: [],
        snapshotting: false,
        inFlight: new Set(),
      };
      this.histories.set(plugin, h);
    }
    return h;
  }

  private load(plugin: string): Promise<void> {
    const h = this.history(plugin);
    h.loading ??= (async () => {
      if (this.opts.presenter) {
        const saved = await db.loadLog(this.opts.deck, plugin).catch(() => null);
        if (saved && isLog(saved)) {
          // Commits made before loading finished go after the saved ones.
          h.log = { ...saved, pending: [...saved.pending, ...h.log.pending] };
          h.snapshot = saved.base.snapshot ? await this.readSnapshot(saved.base.snapshot) : null;
          if (h.snapshot === undefined) {
            // Its snapshot is gone: nothing to build on.
            h.log = { ...h.log, base: EMPTY_BASE, entries: [] };
            h.snapshot = null;
          }
        }
      }
      h.ready = true;
      if (this.opts.presenter && this.pages !== null) this.setPages(this.pages);
      this.opts.deliver(plugin, this.stateMessage(h));
      this.link.loaded?.(plugin);
      await this.catchUp(plugin);
    })();
    return h.loading;
  }

  /** A snapshot's content, or undefined when it can't be had. */
  private async readSnapshot(sha: string): Promise<unknown> {
    const blob = await this.getBlob(sha);
    if (!blob) return undefined;
    try {
      return JSON.parse(await blob.text());
    } catch {
      return undefined;
    }
  }

  private stateMessage(h: PluginHistory): HistoryFrameMessage {
    return { kind: "state", base: h.log.base, snapshot: h.snapshot ?? null, entries: h.log.entries, pending: h.log.pending, device: this.device };
  }

  /** Catch up with whoever orders edits, then send what's pending. */
  private async catchUp(plugin: string) {
    const h = this.histories.get(plugin);
    if (!h?.ready || h.syncing) return;
    if (this.link.ordersHere) {
      this.sendPending(plugin);
      return;
    }
    if (!this.link.sync || !this.linked) return;
    h.syncing = true;
    try {
      const reply = await this.link.sync(plugin, headOf(h.log));
      if (reply.kind === "empty") {
        // A deck shared with edits already on it: they become the session's.
        // Until it takes, nothing more goes up: new edits would start a
        // second line of history there.
        if (this.opts.presenter && !isEmpty(h.log) && this.link.seed && !(await this.link.seed(plugin, h.log))) {
          throw new Error("the server didn't take this device's copy");
        }
      } else if (reply.kind === "tail") {
        for (const entry of reply.entries) this.append(plugin, h, entry);
      } else if (reply.kind === "reset") {
        const snapshot = reply.base.snapshot ? await this.readSnapshot(reply.base.snapshot) : null;
        if (snapshot === undefined) throw new Error("couldn't read the history's snapshot");
        h.log = { ...h.log, base: reply.base, entries: reply.entries };
        h.snapshot = snapshot;
        h.log.pending = h.log.pending.filter((p) => !reply.entries.some((e) => e.id === p.id));
        this.scheduleSave(plugin);
        this.opts.deliver(plugin, this.stateMessage(h));
      }
    } catch (e) {
      console.warn(`Couldn't catch up on plugin "${plugin}"'s history:`, e);
      h.syncing = false;
      return;
    }
    h.syncing = false;
    // What arrived meanwhile, in order.
    const held = h.held.sort((a, b) => a.seq - b.seq);
    h.held = [];
    for (const entry of held) this.receive(plugin, entry);
    this.sendPending(plugin);
  }

  private sendPending(plugin: string) {
    const h = this.histories.get(plugin);
    if (!h?.ready) return;
    for (const p of h.log.pending) void this.send(plugin, p);
  }

  /** Have a pending op ordered: by the link, or here. */
  private async send(plugin: string, pending: PendingOp) {
    const h = this.histories.get(plugin);
    if (!h || h.inFlight.has(pending.id)) return;
    if (this.link.ordersHere) {
      h.inFlight.add(pending.id);
      this.ordering = this.ordering.then(() => this.orderHere(plugin, pending.id));
      return;
    }
    if (!this.linked || !this.link.commit) return;
    h.inFlight.add(pending.id);
    let error: string | null;
    try {
      error = await this.link.commit(plugin, pending);
    } catch {
      // No answer (disconnected): it goes again once the link is back.
      h.inFlight.delete(pending.id);
      return;
    }
    if (error) {
      h.inFlight.delete(pending.id);
      this.drop(plugin, pending.id, error);
    }
  }

  /** A local deck: this device is where edits are ordered. */
  private async orderHere(plugin: string, id: string) {
    const h = this.histories.get(plugin);
    const pending = h?.log.pending.find((p) => p.id === id);
    if (!h || !pending) return;
    const top = headOf(h.log);
    const entry: HistoryEntry = {
      seq: top.seq + 1,
      id: pending.id,
      by: pending.by,
      at: Date.now(),
      op: pending.op,
      hash: await entryHash(top.hash, pending.id, pending.op),
    };
    this.append(plugin, h, entry);
    this.link.publish?.(plugin, entry);
  }

  private drop(plugin: string, id: string, error: string) {
    const h = this.histories.get(plugin);
    if (!h) return;
    h.log.pending = h.log.pending.filter((p) => p.id !== id);
    console.warn(`Plugin "${plugin}"'s edit was refused: ${error}`);
    this.opts.deliver(plugin, { kind: "error", id, error });
    this.opts.deliver(plugin, { kind: "pending", pending: h.log.pending });
    this.scheduleSave(plugin);
  }

  private append(plugin: string, h: PluginHistory, entry: HistoryEntry) {
    if (entry.seq !== headOf(h.log).seq + 1) return;
    h.log.entries.push(entry);
    h.inFlight.delete(entry.id);
    h.log.pending = h.log.pending.filter((p) => p.id !== entry.id);
    this.opts.deliver(plugin, { kind: "entry", entry, pending: h.log.pending });
    this.scheduleSave(plugin);
    this.maybeSnapshot(plugin, h);
  }

  /** The presenter's device lets the log start later once it's long. */
  private maybeSnapshot(plugin: string, h: PluginHistory) {
    if (!this.opts.presenter || h.snapshotting) return;
    const { entries } = h.log;
    if (entries.length < SNAPSHOT_ENTRIES && JSON.stringify(entries).length < SNAPSHOT_BYTES) return;
    h.snapshotting = true;
    void (async () => {
      try {
        const snap = await this.opts.requestSnapshot(plugin);
        if (!snap) return;
        const at = h.log.entries.find((e) => e.seq === snap.seq);
        if (!at) return;
        const blob = new Blob([JSON.stringify(snap.data)], { type: "application/json" });
        const sha = await this.putBlob(blob);
        const base: HistoryBase = { seq: at.seq, hash: at.hash, snapshot: sha };
        if (this.link.snapshot && !(await this.link.snapshot(plugin, base))) return;
        h.log = { ...h.log, base, entries: h.log.entries.filter((e) => e.seq > at.seq) };
        h.snapshot = snap.data;
        this.scheduleSave(plugin);
      } catch (e) {
        console.warn(`Couldn't snapshot plugin "${plugin}"'s history:`, e);
      } finally {
        h.snapshotting = false;
      }
    })();
  }

  /** A different document: start the plugin's history afresh, everywhere. */
  private reset(plugin: string) {
    const h = this.histories.get(plugin);
    if (!h) return;
    h.log = { base: EMPTY_BASE, entries: [], pending: [], pages: this.pages };
    h.snapshot = null;
    h.held = [];
    this.link.reset?.(plugin);
    this.scheduleSave(plugin);
    this.opts.deliver(plugin, this.stateMessage(h));
  }

  private scheduleSave(plugin: string) {
    if (!this.opts.presenter || this.saveTimers.has(plugin)) return;
    this.saveTimers.set(plugin, setTimeout(() => this.save(plugin), SAVE_DELAY_MS));
  }

  private save(plugin: string) {
    clearTimeout(this.saveTimers.get(plugin));
    this.saveTimers.delete(plugin);
    const h = this.histories.get(plugin);
    if (!h?.ready) return;
    const done = isEmpty(h.log) && !h.log.pending.length ? db.deleteLog(this.opts.deck, plugin) : db.saveLog(this.opts.deck, plugin, h.log);
    void done.catch((e) => console.warn(`Couldn't save plugin "${plugin}"'s history:`, e));
  }
}

function headOf(log: HistoryLog): { seq: number; hash: string } {
  const last = log.entries[log.entries.length - 1];
  return last ? { seq: last.seq, hash: last.hash } : { seq: log.base.seq, hash: log.base.hash };
}

function isEmpty(log: HistoryLog): boolean {
  return log.base.seq === 0 && !log.base.snapshot && !log.entries.length;
}

function isLog(v: unknown): v is HistoryLog {
  const l = v as Partial<HistoryLog> | null;
  return !!l && typeof l.base === "object" && Array.isArray(l.entries) && Array.isArray(l.pending);
}
