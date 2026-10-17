// presio.history and presio.blobs ("history" permission): a plugin's ordered
// edit log for the deck, the same on every device, and content-addressed
// bytes. The log itself is HistoryHub's (../history.ts); this is its link to
// the frames.

import { HistoryHub, MAX_BLOB_BYTES, type HistoryFrameMessage } from "../history";
import { HostError, primaryFrame, type HostCore, type MethodTable } from "./types";

/** How long a frame may take to hand over a snapshot of its history. */
const SNAPSHOT_TIMEOUT_MS = 10_000;
/** An op's id, as a frame makes it. */
const OP_ID_RE = /^[A-Za-z0-9_-]{8,40}$/;

export class History {
  private core: HostCore;
  readonly hub: HistoryHub;

  constructor(core: HostCore) {
    this.core = core;
    this.hub = new HistoryHub({
      deck: core.ctx.session.id,
      presenter: core.ctx.role === "presenter",
      deliver: (plugin, message) => this.deliver(plugin, message),
      requestSnapshot: (plugin) => this.requestSnapshot(plugin),
    });
  }

  readonly methods: MethodTable = {
    "history.open": {
      permission: "history",
      handler: (conn, p) => {
        conn.history = true;
        conn.snapshots = p.snapshots === true;
        this.hub.open(conn.plugin.id);
        return null;
      },
    },
    "history.commit": {
      permission: "history",
      handler: (conn, p) => {
        if (typeof p.id !== "string" || !OP_ID_RE.test(p.id)) throw new HostError("InvalidParams", "history.commit needs the op's id");
        const error = this.hub.commit(conn.plugin.id, p.id, p.op);
        if (error) throw new HostError("InvalidParams", error);
        return null;
      },
    },
    "blobs.put": {
      permission: "history",
      handler: async (_conn, p) => {
        const data = p.data;
        const blob =
          data instanceof Blob ? data
          : data instanceof Uint8Array || data instanceof ArrayBuffer ? new Blob([data as BlobPart])
          : null;
        if (!blob) throw new HostError("InvalidParams", "blobs.put takes a Blob, a Uint8Array or an ArrayBuffer");
        if (blob.size > MAX_BLOB_BYTES) throw new HostError("InvalidParams", `A blob is at most ${MAX_BLOB_BYTES / 1024 / 1024} MB`);
        try {
          return await this.hub.putBlob(blob);
        } catch (e) {
          throw new HostError("Internal", e instanceof Error ? e.message : "Couldn't keep the blob");
        }
      },
    },
    "blobs.get": {
      permission: "history",
      handler: (_conn, p) => {
        if (typeof p.sha !== "string" || !/^[0-9a-f]{64}$/.test(p.sha)) throw new HostError("InvalidParams", "blobs.get takes a blob's hash");
        return this.hub.getBlob(p.sha);
      },
    },
  };

  private deliver(plugin: string, message: HistoryFrameMessage) {
    for (const conn of this.core.framesOf(plugin)) {
      if (conn.history) this.core.emit(conn, "history.update", message);
    }
  }

  /** Ask one of a plugin's frames (its background, if open) for a snapshot. */
  private async requestSnapshot(plugin: string): Promise<{ seq: number; data: unknown } | null> {
    const conn = primaryFrame(this.core.framesOf(plugin).filter((c) => c.history && c.snapshots));
    if (!conn) return null;
    try {
      const { seq, data } = (await this.core.call<{ seq?: unknown; data?: unknown }>(conn, "history.snapshot", {}, SNAPSHOT_TIMEOUT_MS)) ?? {};
      return typeof seq === "number" && Number.isInteger(seq) && data !== undefined && data !== null ? { seq, data } : null;
    } catch {
      return null;
    }
  }
}
