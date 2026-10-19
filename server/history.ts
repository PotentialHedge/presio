// Plugin histories (presio.history): each plugin's ordered edit log for the
// deck a session shows, while the session is live.
//
// The presenter's device keeps the copy that lasts (IndexedDB). While the
// deck is shared the server is the one place every device's edits meet, so it
// orders them: each commit gets the next sequence number and a hash chained
// onto the previous entry's, and goes to everyone in the session. A device
// that reconnects sends the head it has (seq + hash) and gets only what it's
// missing — or, when the hashes say it's on another line of history, the whole
// thing again.
//
// The server never looks inside an entry's op. What it keeps: a base (where
// the log starts: a sequence number, its hash and, when the presenter took
// one, a snapshot of the plugin's state as a blob) and the entries after it.
// Blobs are content-addressed bytes (snapshots, images) plugins put and fetch
// over HTTP rather than the socket, so a big one never holds up the session.
//
// Everything here is the session's and goes with it: kept in the storage
// bucket beside the session's PDF (so a server restart loses nothing) and
// removed when the session ends or expires.

import { createHash } from "crypto";
import { PLUGIN_ID_RE } from "./validation.js";
import { jsonBytes, MAX_BLOB_BYTES, MAX_HISTORY_OP_BYTES } from "../shared/limits.js";
import { EMPTY_HASH, entryPreimage, headOf, syncReply, type HistoryBase, type HistoryEntry, type HistorySyncReply } from "../shared/history.js";

export { EMPTY_HASH, type HistoryBase, type HistoryEntry, type HistorySyncReply };

export { MAX_BLOB_BYTES, MAX_HISTORY_OP_BYTES };

/** A commit, as a device sends it. */
export interface HistoryCommit {
  plugin: string;
  id: string;
  by: string;
  op: unknown;
}

/** The part of a Storage bucket this uses (Supabase's, or server/local's). */
export interface HistoryBucket {
  upload(path: string, body: Buffer, opts?: { contentType?: string; upsert?: boolean }): Promise<{ error: { message: string } | null }>;
  download(path: string): Promise<{ data: Blob | null; error: { message: string } | null }>;
  remove(paths: string[]): Promise<unknown>;
}

// The entries kept after a plugin's base. A plugin whose log grows past this
// has to take snapshots (presio.history's `snapshot` option).
export const MAX_HISTORY_TAIL_BYTES = 4 * 1024 * 1024;
export const MAX_SESSION_BLOB_BYTES = 50 * 1024 * 1024;
export const MAX_HISTORY_PLUGINS = 8;
// Ids remembered per plugin to recognise a resent commit (a device that lost
// its connection before hearing back resends what's still pending).
const RECENT_IDS = 1024;
const PERSIST_DELAY_MS = 1000;

export const SHA256_RE = /^[0-9a-f]{64}$/;

/** The hash of an entry: chained onto the one before it. */
export function entryHash(prev: string, id: string, op: unknown): string {
  return createHash("sha256").update(entryPreimage(prev, id, op)).digest("hex");
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface PluginHistory {
  base: HistoryBase;
  entries: HistoryEntry[];
  /** The entries' size as JSON, for MAX_HISTORY_TAIL_BYTES. */
  bytes: number;
  recent: string[];
}

interface SessionHistory {
  plugins: Map<string, PluginHistory>;
  /** Blobs stored for the session, by sha, with their sizes. */
  blobs: Map<string, number>;
  persistTimer: ReturnType<typeof setTimeout> | null;
}

/** What's saved in the bucket for a session. */
interface SavedHistory {
  plugins: Record<string, { base: HistoryBase; entries: HistoryEntry[] }>;
  blobs: Record<string, number>;
}

const logPath = (sessionId: string) => `history/${sessionId}/log.json`;
const blobPath = (sessionId: string, sha: string) => `history/${sessionId}/blobs/${sha}`;

export class HistoryError extends Error {}

export class HistoryStore {
  private sessions = new Map<string, Promise<SessionHistory>>();
  private bucket: HistoryBucket | null = null;

  /** Where histories and blobs are kept (the deployment's Storage bucket). */
  setBucket(bucket: HistoryBucket) {
    this.bucket = bucket;
  }

  private session(sessionId: string): Promise<SessionHistory> {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = this.load(sessionId);
      this.sessions.set(sessionId, s);
      // A failed load is retried next time rather than cached.
      s.catch(() => {
        if (this.sessions.get(sessionId) === s) this.sessions.delete(sessionId);
      });
    }
    return s;
  }

  private async load(sessionId: string): Promise<SessionHistory> {
    const s: SessionHistory = { plugins: new Map(), blobs: new Map(), persistTimer: null };
    if (!this.bucket) return s;
    const { data } = await this.bucket.download(logPath(sessionId));
    if (!data) return s;
    let saved: SavedHistory;
    try {
      saved = JSON.parse(await data.text()) as SavedHistory;
    } catch {
      return s;
    }
    for (const [plugin, h] of Object.entries(saved.plugins ?? {})) {
      const entries = Array.isArray(h.entries) ? h.entries : [];
      s.plugins.set(plugin, {
        base: h.base,
        entries,
        bytes: entries.reduce((n, e) => n + jsonBytes(e), 0),
        recent: entries.slice(-RECENT_IDS).map((e) => e.id),
      });
    }
    for (const [sha, size] of Object.entries(saved.blobs ?? {})) {
      if (SHA256_RE.test(sha) && typeof size === "number") s.blobs.set(sha, size);
    }
    return s;
  }

  private schedulePersist(sessionId: string, s: SessionHistory) {
    if (s.persistTimer || !this.bucket) return;
    s.persistTimer = setTimeout(() => {
      s.persistTimer = null;
      void this.persist(sessionId, s);
    }, PERSIST_DELAY_MS);
  }

  private async persist(sessionId: string, s: SessionHistory) {
    if (!this.bucket || this.sessions.get(sessionId) === undefined) return;
    const saved: SavedHistory = { plugins: {}, blobs: Object.fromEntries(s.blobs) };
    for (const [plugin, h] of s.plugins) saved.plugins[plugin] = { base: h.base, entries: h.entries };
    const { error } = await this.bucket.upload(logPath(sessionId), Buffer.from(JSON.stringify(saved)), {
      contentType: "application/json",
      upsert: true,
    });
    if (error) console.warn(`Couldn't save the history of session ${sessionId}:`, error.message);
  }

  /** What a device with this head is missing. */
  async sync(sessionId: string, plugin: string, head: { seq: number; hash: string }): Promise<HistorySyncReply> {
    const h = (await this.session(sessionId)).plugins.get(plugin);
    if (!h) return { kind: "empty" };
    return syncReply(h, head);
  }

  /**
   * Order a commit. Returns the new entry, or null for a resend of one that's
   * already in (nothing to send again).
   */
  async commit(sessionId: string, c: HistoryCommit): Promise<HistoryEntry | null> {
    const s = await this.session(sessionId);
    let h = s.plugins.get(c.plugin);
    if (!h) {
      if (s.plugins.size >= MAX_HISTORY_PLUGINS) throw new HistoryError("Too many plugins keep a history in this session");
      h = { base: { seq: 0, hash: EMPTY_HASH, snapshot: null }, entries: [], bytes: 0, recent: [] };
      s.plugins.set(c.plugin, h);
    }
    if (h.recent.includes(c.id)) return null;
    const prev = headOf(h);
    const entry: HistoryEntry = {
      seq: prev.seq + 1,
      id: c.id,
      by: c.by,
      at: Date.now(),
      op: c.op,
      hash: entryHash(prev.hash, c.id, c.op),
    };
    const size = jsonBytes(entry);
    if (h.bytes + size > MAX_HISTORY_TAIL_BYTES) {
      throw new HistoryError("This plugin's history is full: it needs to take snapshots");
    }
    h.entries.push(entry);
    h.bytes += size;
    h.recent.push(c.id);
    if (h.recent.length > RECENT_IDS) h.recent.splice(0, h.recent.length - RECENT_IDS);
    this.schedulePersist(sessionId, s);
    return entry;
  }

  /**
   * Start a plugin's history from a device's copy (a deck shared with edits
   * already on it): the seed is a blob, { base, entries }, uploaded first.
   * Only where the session has none yet — otherwise the server's copy stands.
   */
  async seed(sessionId: string, plugin: string, seedSha: string): Promise<boolean> {
    const s = await this.session(sessionId);
    const existing = s.plugins.get(plugin);
    if (existing && (existing.entries.length || existing.base.seq > 0)) return false;
    if (!s.plugins.has(plugin) && s.plugins.size >= MAX_HISTORY_PLUGINS) return false;
    const bytes = await this.getBlob(sessionId, seedSha);
    if (!bytes) return false;
    let raw: unknown;
    try {
      raw = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      return false;
    }
    const seed = parseSeed(raw);
    if (!seed || (seed.base.snapshot && !s.blobs.has(seed.base.snapshot))) return false;
    const bytesOf = seed.entries.reduce((n, e) => n + jsonBytes(e), 0);
    if (bytesOf > MAX_HISTORY_TAIL_BYTES) return false;
    s.plugins.set(plugin, {
      base: seed.base,
      entries: seed.entries,
      bytes: bytesOf,
      recent: seed.entries.slice(-RECENT_IDS).map((e) => e.id),
    });
    // The seed itself was only the way in.
    await this.removeBlob(sessionId, s, seedSha);
    this.schedulePersist(sessionId, s);
    return true;
  }

  /**
   * The presenter took a snapshot of a plugin's state at `seq` (an entry the
   * server has, by its hash): the log can start there.
   */
  async snapshot(sessionId: string, plugin: string, at: { seq: number; hash: string; sha: string }): Promise<boolean> {
    const s = await this.session(sessionId);
    const h = s.plugins.get(plugin);
    if (!h || !s.blobs.has(at.sha)) return false;
    const i = h.entries.findIndex((e) => e.seq === at.seq && e.hash === at.hash);
    if (i < 0) return false;
    const old = h.base.snapshot;
    h.base = { seq: at.seq, hash: at.hash, snapshot: at.sha };
    const dropped = h.entries.splice(0, i + 1);
    h.bytes -= dropped.reduce((n, e) => n + jsonBytes(e), 0);
    if (old && old !== at.sha) await this.removeBlob(sessionId, s, old);
    this.schedulePersist(sessionId, s);
    return true;
  }

  /** Forget a plugin's history (the deck was replaced by a different one). */
  async reset(sessionId: string, plugin: string): Promise<void> {
    const s = await this.session(sessionId);
    const h = s.plugins.get(plugin);
    if (!h) return;
    s.plugins.delete(plugin);
    if (h.base.snapshot) await this.removeBlob(sessionId, s, h.base.snapshot);
    this.schedulePersist(sessionId, s);
  }

  /** Keep a blob for the session. Throws a HistoryError when it can't. */
  async putBlob(sessionId: string, sha: string, bytes: Buffer): Promise<void> {
    if (!this.bucket) throw new HistoryError("Blobs aren't available on this server");
    if (bytes.length > MAX_BLOB_BYTES) throw new HistoryError("Blob too large");
    if (sha256(bytes) !== sha) throw new HistoryError("The blob doesn't match its hash");
    const s = await this.session(sessionId);
    if (s.blobs.has(sha)) return;
    let total = 0;
    for (const size of s.blobs.values()) total += size;
    if (total + bytes.length > MAX_SESSION_BLOB_BYTES) throw new HistoryError("This session's blob storage is full");
    const { error } = await this.bucket.upload(blobPath(sessionId, sha), bytes, {
      contentType: "application/octet-stream",
      upsert: true,
    });
    if (error) throw new Error(error.message);
    s.blobs.set(sha, bytes.length);
    this.schedulePersist(sessionId, s);
  }

  /** A blob's bytes, or null when the session has no such blob. */
  async getBlob(sessionId: string, sha: string): Promise<Uint8Array | null> {
    if (!this.bucket) return null;
    const s = await this.session(sessionId);
    if (!s.blobs.has(sha)) return null;
    const { data } = await this.bucket.download(blobPath(sessionId, sha));
    return data ? new Uint8Array(await data.arrayBuffer()) : null;
  }

  private async removeBlob(sessionId: string, s: SessionHistory, sha: string) {
    if (!s.blobs.delete(sha)) return;
    await this.bucket?.remove([blobPath(sessionId, sha)]);
  }

  /** The session is over: drop everything it kept. */
  async drop(sessionId: string): Promise<void> {
    const pending = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    if (!this.bucket) return;
    let s: SessionHistory | null = null;
    try {
      s = pending ? await pending : await this.load(sessionId);
    } catch {
      /* nothing readable to drop but the log */
    }
    if (s?.persistTimer) clearTimeout(s.persistTimer);
    const paths = [logPath(sessionId), ...[...(s?.blobs.keys() ?? [])].map((sha) => blobPath(sessionId, sha))];
    await this.bucket.remove(paths);
  }
}

const ENTRY_ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const HASH_OR_EMPTY_RE = /^([0-9a-f]{64})?$/;

function parseSeed(raw: unknown): { base: HistoryBase; entries: HistoryEntry[] } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as { base?: unknown; entries?: unknown };
  const base = parseBase(r.base);
  if (!base || !Array.isArray(r.entries)) return null;
  const entries: HistoryEntry[] = [];
  let prev = base;
  for (const e of r.entries) {
    const entry = parseEntry(e);
    // The seed's entries carry on from its base, one after another.
    if (!entry || entry.seq !== prev.seq + 1 || jsonBytes(entry.op) > MAX_HISTORY_OP_BYTES) return null;
    entries.push(entry);
    prev = { seq: entry.seq, hash: entry.hash, snapshot: null };
  }
  return { base, entries };
}

export function parseBase(raw: unknown): HistoryBase | null {
  if (typeof raw !== "object" || raw === null) return null;
  const b = raw as Record<string, unknown>;
  if (!isSeq(b.seq) || typeof b.hash !== "string" || !HASH_OR_EMPTY_RE.test(b.hash)) return null;
  const snapshot = b.snapshot === null || b.snapshot === undefined ? null : b.snapshot;
  if (snapshot !== null && (typeof snapshot !== "string" || !SHA256_RE.test(snapshot))) return null;
  return { seq: b.seq, hash: b.hash, snapshot };
}

function parseEntry(raw: unknown): HistoryEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const e = raw as Record<string, unknown>;
  if (!isSeq(e.seq) || e.seq < 1) return null;
  if (typeof e.id !== "string" || !ENTRY_ID_RE.test(e.id) || typeof e.by !== "string" || !ENTRY_ID_RE.test(e.by)) return null;
  if (typeof e.at !== "number" || !Number.isFinite(e.at)) return null;
  if (typeof e.hash !== "string" || !SHA256_RE.test(e.hash) || e.op === undefined) return null;
  return { seq: e.seq, id: e.id, by: e.by, at: e.at, op: e.op, hash: e.hash };
}

const isSeq = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** A commit from a socket: a known plugin id, ids that fit, an op that fits. */
export function sanitizeHistoryCommit(raw: unknown): HistoryCommit | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.plugin !== "string" || !PLUGIN_ID_RE.test(c.plugin)) return null;
  if (typeof c.id !== "string" || !ENTRY_ID_RE.test(c.id) || typeof c.by !== "string" || !ENTRY_ID_RE.test(c.by)) return null;
  if (c.op === undefined || c.op === null || jsonBytes(c.op) > MAX_HISTORY_OP_BYTES) return null;
  return { plugin: c.plugin, id: c.id, by: c.by, op: c.op };
}

/** A head a device reports: where its copy of a history ends. */
export function sanitizeHead(raw: unknown): { seq: number; hash: string } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const h = raw as Record<string, unknown>;
  if (!isSeq(h.seq) || typeof h.hash !== "string" || !HASH_OR_EMPTY_RE.test(h.hash)) return null;
  return { seq: h.seq, hash: h.hash };
}
