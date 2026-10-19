// presio.history's core, the part every device and the server must agree on:
// the shape of a log, where it's at (its head), what a device with some head
// is missing, and what an entry's hash covers. A one-sided change to the
// preimage would silently fork every history, so it lives here once.
// client/src/lib/plugins/history.ts and server/history.ts build on it.

export interface HistoryEntry {
  seq: number;
  /** The committing device's id for the op: resends are recognised by it. */
  id: string;
  /** The device that committed it (per-device undo). */
  by: string;
  /** Time it was ordered at (ms). */
  at: number;
  op: unknown;
  hash: string;
}

export interface HistoryBase {
  seq: number;
  hash: string;
  /** SHA-256 of the snapshot blob the log starts from, or null for the plugin's init(). */
  snapshot: string | null;
}

export interface HistoryHead {
  seq: number;
  hash: string;
}

export type HistorySyncReply =
  | { kind: "empty" }
  | { kind: "current" }
  | { kind: "tail"; entries: HistoryEntry[] }
  | { kind: "reset"; base: HistoryBase; entries: HistoryEntry[] };

export const EMPTY_HASH = "";

/** Where a log is at: its last entry, or its base when it has none. */
export function headOf(log: { base: HistoryBase; entries: HistoryEntry[] }): HistoryHead {
  const last = log.entries[log.entries.length - 1];
  return last ? { seq: last.seq, hash: last.hash } : { seq: log.base.seq, hash: log.base.hash };
}

/** What a device at `head` is missing from this log. */
export function syncReply(log: { base: HistoryBase; entries: HistoryEntry[] }, head: HistoryHead): HistorySyncReply {
  const { base, entries } = log;
  const top = headOf(log);
  if (head.seq === top.seq && head.hash === top.hash) return { kind: "current" };
  // On this line of history, and not from before the base: just the rest.
  const known =
    (head.seq === base.seq && head.hash === base.hash) ||
    entries.some((e) => e.seq === head.seq && e.hash === head.hash);
  if (known) return { kind: "tail", entries: entries.filter((e) => e.seq > head.seq) };
  return { kind: "reset", base, entries };
}

/** What an entry's SHA-256 is taken of: chained onto the one before it. */
export function entryPreimage(prev: string, id: string, op: unknown): string {
  return `${prev}\n${id}\n${JSON.stringify(op)}`;
}
