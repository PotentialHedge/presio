// A shared deck's links to the server for plugins: where viewers' input
// (presio.audience) is held, and the server's copy of the edit histories
// (presio.history) and their blobs.

import { socket } from "@/lib/socket";
import { getSessionAuth } from "@/lib/utils";
import { jsonBytes } from "@shared/limits";
import type { AudienceKeyState } from "@shared/plugin/audience";
import type { AudienceLink } from "./host";
import { blobSha, type HistoryLink, type SyncReply } from "./history";
import type { PluginManifest } from "./manifest";

/** Plugins that run on audience devices, which the presenter publishes. */
export function runsOnViewers(manifest: Pick<PluginManifest, "surfaces">): boolean {
  return manifest.surfaces.some((s) => s === "viewer" || s === "viewerSheet" || s === "slide");
}

/** How long to wait on an answer about a viewer's slot. */
const AUDIENCE_ACK_MS = 8000;
/** At most this much of the presenter's mirror per seed message (a socket
 *  message to the server is at most 1 MB). */
const AUDIENCE_SEED_PART_BYTES = 256 * 1024;

/** A plugin that collects viewers' input: published to viewers, with the permission. */
export const collectsAudience = (manifest: Pick<PluginManifest, "surfaces" | "permissions">) =>
  runsOnViewers(manifest) && manifest.permissions.includes("audience");

/** Ask the server about the audience; rejects with its reason. */
export async function askAudience<T>(event: string, args: unknown): Promise<T> {
  let reply: (T & { error?: string }) | undefined;
  try {
    reply = await socket.timeout(AUDIENCE_ACK_MS).emitWithAck(event, args);
  } catch {
    throw new Error("Couldn't reach the server");
  }
  if (reply?.error) throw new Error(reply.error);
  return reply as T;
}

/** A shared deck's link: the server holds the slots. */
export function sharedAudienceLink(): AudienceLink {
  const ask = (event: string) => async (plugin: string, key: string) => void (await askAudience(event, { plugin, key }));
  return {
    open: ask("audience_open"),
    close: ask("audience_close"),
    clear: ask("audience_clear"),
    set: async (plugin, key, value) => void (await askAudience("audience_set", { plugin, key, value })),
  };
}

/** The presenter's mirror of a plugin's slots, in parts small enough to send. */
export function seedParts(keys: Record<string, AudienceKeyState>): Record<string, AudienceKeyState>[] {
  const parts: Record<string, AudienceKeyState>[] = [];
  let part: Record<string, AudienceKeyState> = {};
  let bytes = 0;
  for (const [key, { open, slots }] of Object.entries(keys)) {
    part[key] = { open, slots: {} };
    for (const [viewer, value] of Object.entries(slots)) {
      const size = jsonBytes(value) + viewer.length;
      if (bytes + size > AUDIENCE_SEED_PART_BYTES && bytes > 0) {
        parts.push(part);
        part = { [key]: { open, slots: {} } };
        bytes = 0;
      }
      part[key].slots[viewer] = value;
      bytes += size;
    }
  }
  parts.push(part);
  return parts;
}

/** How long to wait on the server's answer about a history. */
const HISTORY_ACK_MS = 15_000;
// A blob another device just added may not be uploaded yet: ask again after
// these waits before giving up (the plugin can ask again later).
const BLOB_RETRY_MS = [1000, 2000, 4000, 8000];

/** A shared deck's way to the server's copy of the histories, and its blobs. */
export function sharedHistoryLink(
  id: string,
  isPresenter: boolean,
  localBlob: (sha: string) => Promise<Blob | null>
): HistoryLink & { retryUploads(): void } {
  const ask = async <T,>(event: string, args: unknown): Promise<T> => socket.timeout(HISTORY_ACK_MS).emitWithAck(event, args);
  const blobUrl = (sha: string) => `/api/sessions/${encodeURIComponent(id)}/blobs/${sha}`;
  // Blobs that couldn't be uploaded yet (offline): tried again on reconnecting.
  const unsent = new Map<string, Blob>();

  const upload = async (sha: string, blob: Blob) => {
    const res = await fetch(blobUrl(sha), {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream", "x-controller-token": getSessionAuth(id).controllerToken ?? "" },
      body: blob,
    });
    if (res.ok) {
      unsent.delete(sha);
      return;
    }
    const body = await res.json().catch(() => ({}));
    // Refused for good (too big, storage full): the plugin should hear.
    if (res.status === 413 || res.status === 422) throw new Error(body.error || "The server refused the blob");
    throw new TypeError(body.error || `upload failed (${res.status})`);
  };

  const tryUpload = async (sha: string, blob: Blob) => {
    try {
      await upload(sha, blob);
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
      unsent.set(sha, blob);
    }
  };

  return {
    sync: async (plugin, head) => {
      const reply = await ask<SyncReply | { error: string }>("history_sync", { plugin, head });
      if ("error" in reply) throw new Error(reply.error);
      return reply;
    },
    ...(isPresenter
      ? {
          commit: async (plugin, op) => {
            const reply = await ask<{ ok?: boolean; error?: string }>("history_commit", { plugin, id: op.id, by: op.by, op: op.op });
            return reply?.error ?? null;
          },
          seed: async (plugin, log) => {
            if (log.base.snapshot) {
              const snapshot = await localBlob(log.base.snapshot);
              if (!snapshot) return false;
              await upload(log.base.snapshot, snapshot);
            }
            const seed = new Blob([JSON.stringify({ base: log.base, entries: log.entries })], { type: "application/json" });
            const sha = await blobSha(seed);
            await upload(sha, seed);
            const reply = await ask<{ ok?: boolean }>("history_seed", { plugin, sha });
            return reply?.ok === true;
          },
          snapshot: async (plugin, base) => {
            if (base.snapshot && unsent.has(base.snapshot)) return false;
            const reply = await ask<{ ok?: boolean }>("history_snapshot", { plugin, base });
            return reply?.ok === true;
          },
          reset: (plugin) => void socket.emit("history_reset", { plugin }),
          uploadBlob: tryUpload,
        }
      : {}),
    fetchBlob: async (sha) => {
      for (let attempt = 0; ; attempt++) {
        try {
          // Low priority: a blob never gets ahead of the slides themselves.
          const res = await fetch(blobUrl(sha), { priority: "low" } as RequestInit);
          if (res.ok) return await res.blob();
          if (res.status !== 404) return null;
        } catch {
          /* offline: try again */
        }
        if (attempt >= BLOB_RETRY_MS.length) return null;
        await new Promise((r) => setTimeout(r, BLOB_RETRY_MS[attempt]));
      }
    },
    retryUploads: () => {
      for (const [sha, blob] of unsent) void tryUpload(sha, blob).catch(() => unsent.delete(sha));
    },
  };
}
