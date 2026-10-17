// Wires a PluginHost into a running presentation: which plugins are active on
// this device, and the transport their messages travel over.
//
// The presenter decides what runs. It activates its enabled plugins against the
// deck and, for a shared deck, publishes the ones with a viewer surface to the
// session so audience devices run exactly those — viewers never install
// anything. A local deck's viewer window is in the same browser, so it reads
// the same registry and syncs over a BroadcastChannel instead.

import { useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { socket } from "@/lib/socket";
import { readAttachments, type PdfAttachment } from "@/lib/pdf";
import { useJoinUrl } from "@/lib/joinUrl";
import { PluginHost, retainKey, audienceViewerId, type AudienceLink, type PageSize, type PluginContext, type WireEvent } from "./host";
import { isActivatedBy, type LoadedPlugin, type PluginManifest } from "./manifest";
import { loadPlugin, usePluginEntries } from "./registry";
import { clockOffset, onClockSample } from "@/lib/clock";
import { resolvePluginSettings, useSettingsDocument } from "@/lib/settings";
import { getSessionAuth } from "@/lib/utils";
import { blobSha, type HistoryEntry, type HistoryLink, type SyncReply } from "./history";
import type { AudienceJoin, AudienceKeyState, AudienceSummary } from "@shared/plugin/audience";

/** A plugin viewers run: its id, where to load it, and what it must hash to. */
interface PublishedPlugin {
  /** The id its source gives it; a viewer checks what it loads has the same. */
  id: string;
  manifest: Pick<PluginManifest, "name" | "displayName" | "version" | "author" | "description" | "surfaces" | "permissions">;
  /** As the presenter registered it: built-ins by path, so each viewer
   *  loads them from its own origin; others by absolute URL. */
  url: string;
  hash: string;
}

interface PluginsState {
  plugins: PublishedPlugin[];
  /** The presenter's settings for each plugin, by id. */
  settings: Record<string, Record<string, unknown>>;
  retained: WireEvent[];
}

interface SettingsUpdate {
  plugin: string;
  settings: Record<string, unknown>;
}

/** A viewer couldn't load a published plugin (relayed to the presenter). */
interface LoadFailure {
  plugin: string;
  hash: string;
  reason: string;
  sender: string;
}

/** Why a viewer couldn't load a plugin, in a line the presenter can act on. */
function loadFailureReason(e: unknown, url: string): string {
  if (e instanceof TypeError) {
    // fetch() rejects with a TypeError when it can't reach the host at all.
    let host = url;
    try {
      host = new URL(url, window.location.href).host;
    } catch {
      /* keep the URL */
    }
    return `couldn't reach ${host}`;
  }
  const message = e instanceof Error ? e.message : String(e);
  return /changed since/.test(message) ? "it got a different version — pin the plugin's URL to a version" : message;
}

/** Plugins that run on audience devices, which the presenter publishes. */
function runsOnViewers(manifest: Pick<PluginManifest, "surfaces">): boolean {
  return manifest.surfaces.some((s) => s === "viewer" || s === "viewerSheet" || s === "slide");
}

function useTheme(): "light" | "dark" {
  const read = () => (document.documentElement.classList.contains("dark") ? "dark" : "light");
  const [theme, setTheme] = useState<"light" | "dark">(read);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

/** The deck's attachments, read once per document. */
function useAttachmentReader(pdf: PDFDocumentProxy | null) {
  return useMemo(() => {
    let cached: Promise<PdfAttachment[]> | null = null;
    return () => {
      if (!pdf) return Promise.resolve([]);
      return (cached ??= readAttachments(pdf).catch(() => []));
    };
  }, [pdf]);
}

/** The deck's PDF bytes, for plugins that read the file themselves. */
function useBytesReader(pdf: PDFDocumentProxy | null) {
  return useMemo(() => async () => (pdf ? pdf.getData() : null), [pdf]);
}

/** Each page's size in PDF points, read once per document. */
function usePagesReader(pdf: PDFDocumentProxy | null) {
  return useMemo(() => {
    let cached: Promise<PageSize[]> | null = null;
    return () => {
      if (!pdf) return Promise.resolve([]);
      return (cached ??= (async () => {
        const sizes: PageSize[] = [];
        for (let n = 1; n <= pdf.numPages; n++) {
          const [x1, y1, x2, y2] = (await pdf.getPage(n)).view;
          sizes.push({ width: x2 - x1, height: y2 - y1 });
        }
        return sizes;
      })());
    };
  }, [pdf]);
}

/** Enabled plugins from this browser's registry that the deck activates. */
function useLocallyActivePlugins(enabled: boolean, readAll: () => Promise<PdfAttachment[]>) {
  const entries = usePluginEntries();
  const enabledEntries = entries.filter((e) => e.enabled);
  const entriesKey = enabledEntries.map((e) => `${e.key}\n${e.url}`).join("\n\n");
  const entriesRef = useRef(enabledEntries);
  useEffect(() => { entriesRef.current = enabledEntries; });
  const [plugins, setPlugins] = useState<LoadedPlugin[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    (async () => {
      const names = (await readAll()).map((a) => a.filename);
      const loaded: LoadedPlugin[] = [];
      const failed: Record<string, string> = {};
      for (const entry of entriesRef.current) {
        try {
          const plugin = await loadPlugin(entry.url, { source: entry.source, key: entry.key });
          // Ids come from sources, so two entries only share one if the same
          // plugin was added twice (as a URL and as GitHub): the first runs.
          if (isActivatedBy(plugin.manifest, names) && !loaded.some((p) => p.id === plugin.id)) {
            loaded.push(plugin);
          }
        } catch (e) {
          failed[entry.key] = e instanceof Error ? e.message : String(e);
        }
      }
      if (cancelled) return;
      // Keep the objects of plugins that didn't change: a new one for the
      // same plugin would remount its frames (this runs again once the deck's
      // attachments are read).
      setPlugins((prev) => {
        const next = loaded.map((p) => prev.find((q) => q.hash === p.hash && q.id === p.id) ?? p);
        return next.length === prev.length && next.every((p, i) => p === prev[i]) ? prev : next;
      });
      setErrors(failed);
    })();
    return () => { cancelled = true; };
  }, [enabled, entriesKey, readAll]);

  return { plugins: enabled ? plugins : [], errors };
}

// --- presio.audience: the links to wherever viewers' slots are held ---

/** How long to wait on an answer about a viewer's slot. */
const AUDIENCE_ACK_MS = 8000;
/** At most this much of the presenter's mirror per seed message (a socket
 *  message to the server is at most 1 MB). */
const AUDIENCE_SEED_PART_BYTES = 256 * 1024;

/** A plugin that collects viewers' input: published to viewers, with the permission. */
const collectsAudience = (manifest: Pick<PluginManifest, "surfaces" | "permissions">) =>
  runsOnViewers(manifest) && manifest.permissions.includes("audience");

/** Ask the server about the audience; rejects with its reason. */
async function askAudience<T>(event: string, args: unknown): Promise<T> {
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
function sharedAudienceLink(): AudienceLink {
  const ask = (event: string) => async (plugin: string, key: string) => void (await askAudience(event, { plugin, key }));
  return {
    open: ask("audience_open"),
    close: ask("audience_close"),
    clear: ask("audience_clear"),
    set: async (plugin, key, value) => void (await askAudience("audience_set", { plugin, key, value })),
  };
}

/** The presenter's mirror of a plugin's slots, in parts small enough to send. */
function seedParts(keys: Record<string, AudienceKeyState>): Record<string, AudienceKeyState>[] {
  const parts: Record<string, AudienceKeyState>[] = [];
  let part: Record<string, AudienceKeyState> = {};
  let bytes = 0;
  for (const [key, { open, slots }] of Object.entries(keys)) {
    part[key] = { open, slots: {} };
    for (const [viewer, value] of Object.entries(slots)) {
      const size = JSON.stringify(value).length + viewer.length;
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
function sharedHistoryLink(
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

export interface PluginHostState {
  host: PluginHost;
  /** Plugins running on this device. */
  plugins: LoadedPlugin[];
  /** Load failures by registry key (presenter only), for Settings. */
  errors: Record<string, string>;
  /** Presenter of a shared deck: plugins some viewers couldn't load, by registry key. */
  viewerErrors: Record<string, string>;
}

export function usePluginHost({
  id,
  local,
  isPresenter,
  pdf,
  currentSlide,
  totalSlides,
}: {
  id: string;
  /** null until the presentation knows whether it's local. */
  local: boolean | null;
  isPresenter: boolean;
  pdf: PDFDocumentProxy | null;
  currentSlide: number;
  totalSlides: number;
}): PluginHostState {
  const theme = useTheme();
  const join = useJoinUrl(id, "viewer");
  const ctx: PluginContext = {
    role: isPresenter ? "presenter" : "audience",
    theme,
    session: { id, local: !!local, joinUrl: local ? null : join.url },
    slide: { current: currentSlide, total: totalSlides },
  };
  const [host] = useState(() => new PluginHost(ctx));
  useEffect(() => {
    host.updateContext(ctx);
  });

  const readAll = useAttachmentReader(pdf);
  const readBytes = useBytesReader(pdf);
  const readPages = usePagesReader(pdf);
  useEffect(() => host.setDeckSource(readAll, readBytes, readPages), [host, readAll, readBytes, readPages]);

  // Server viewers get their plugin list from the session; everyone else
  // (the presenter, and a local deck's viewer window) from this browser.
  const fromSession = local === false && !isPresenter;
  const localActive = useLocallyActivePlugins(local !== null && !fromSession, readAll);
  const [sessionPlugins, setSessionPlugins] = useState<LoadedPlugin[]>([]);
  const plugins = fromSession ? sessionPlugins : localActive.plugins;
  const pluginsRef = useRef(plugins);
  useEffect(() => { pluginsRef.current = plugins; });

  // Static layers belong to running plugins only, and downloads pass through
  // them in this order.
  const runningIds = plugins.map((p) => p.id).join(",");
  useEffect(() => host.setRunning(runningIds ? runningIds.split(",") : []), [host, runningIds]);

  // Plugins keep their own copy of the server clock (presio.clock).
  useEffect(() => onClockSample(() => host.setClockOffset(clockOffset())), [host]);

  // --- Local deck: BroadcastChannel between this browser's windows ---
  useEffect(() => {
    if (local !== true) return;
    const channel = new BroadcastChannel(`presio-plugins-${id}`);
    host.setOutbound((event) => channel.postMessage({ kind: "event", event }));
    // Histories: the presenter's window orders edits and passes each on; the
    // viewer window asks it for what it's missing (blobs it reads itself,
    // from this browser's IndexedDB).
    const syncs = new Map<number, (reply: SyncReply) => void>();
    let nextSync = 1;
    host.history.setLink(
      isPresenter
        ? {
            ordersHere: true,
            publish: (plugin, entry) => channel.postMessage({ kind: "history_entry", plugin, entry }),
            reset: (plugin) => channel.postMessage({ kind: "history_reset", plugin }),
            loaded: (plugin) => channel.postMessage({ kind: "history_reset", plugin }),
          }
        : {
            sync: (plugin, head) =>
              new Promise<SyncReply>((resolve, reject) => {
                const reqId = nextSync++;
                const timer = setTimeout(() => {
                  syncs.delete(reqId);
                  reject(new Error("the presenter's window didn't answer"));
                }, 5000);
                syncs.set(reqId, (reply) => {
                  clearTimeout(timer);
                  syncs.delete(reqId);
                  resolve(reply);
                });
                channel.postMessage({ kind: "history_sync", reqId, plugin, head });
              }),
          },
      true
    );
    // Audience input: the viewer window is the audience, and this browser's
    // presenter window holds the slots.
    const viewer = audienceViewerId(id);
    const audienceReplies = new Map<string, (error: string | null) => void>();
    host.audience.setLink(
      isPresenter
        ? {
            open: async (plugin, key) => channel.postMessage({ kind: "audience_state", plugin, key, open: true }),
            close: async (plugin, key) => channel.postMessage({ kind: "audience_state", plugin, key, open: false }),
            clear: async (plugin, key) => channel.postMessage({ kind: "audience_cleared", plugin, key }),
          }
        : {
            set: (plugin, key, value) =>
              new Promise<void>((resolve, reject) => {
                const reqId = `${viewer}:${nextSync++}`;
                const timer = setTimeout(() => {
                  audienceReplies.delete(reqId);
                  reject(new Error("The presenter's window didn't answer"));
                }, 5000);
                audienceReplies.set(reqId, (error) => {
                  clearTimeout(timer);
                  audienceReplies.delete(reqId);
                  if (error) reject(new Error(error));
                  else resolve();
                });
                channel.postMessage({ kind: "audience_set", reqId, plugin, key, value, viewer });
              }),
          }
    );
    const onAudience = (m: Record<string, unknown>) => {
      const { kind, plugin, key } = m as { kind: string; plugin: string; key: string };
      if (isPresenter) {
        if (kind === "audience_join") {
          channel.postMessage({ kind: "audience_join_reply", viewer: m.viewer, join: host.audience.joinFor(String(m.viewer)) });
        } else if (kind === "audience_set") {
          const error = host.audience.receiveWrite(plugin, key, String(m.viewer), m.value);
          channel.postMessage({ kind: "audience_set_reply", reqId: m.reqId, error });
        }
        return;
      }
      if (kind === "audience_state") host.audience.receiveKeyState(plugin, key, m.open === true);
      else if (kind === "audience_cleared") host.audience.receiveCleared(plugin, key);
      else if (kind === "audience_join_reply" && m.viewer === viewer) host.audience.receiveJoin(m.join as AudienceJoin);
      else if (kind === "audience_set_reply") audienceReplies.get(String(m.reqId))?.((m.error as string | null) ?? null);
      else if (kind === "audience_resync") channel.postMessage({ kind: "audience_join", viewer });
    };

    channel.onmessage = (e) => {
      const { kind, event, events, plugin, entry, head, reqId, reply } = e.data ?? {};
      if (typeof kind === "string" && kind.startsWith("audience_")) onAudience(e.data);
      else if (kind === "event") host.receive(event);
      else if (kind === "retained") host.seedRetained(events);
      else if (kind === "hello" && isPresenter) channel.postMessage({ kind: "retained", events: host.retainedEvents() });
      else if (kind === "history_entry" && !isPresenter) host.history.receive(plugin, entry as HistoryEntry);
      else if (kind === "history_reset" && !isPresenter) host.history.receiveReset(plugin);
      else if (kind === "history_sync" && isPresenter) {
        channel.postMessage({ kind: "history_sync_reply", reqId, reply: host.history.answerSync(plugin, head) });
      } else if (kind === "history_sync_reply" && !isPresenter) syncs.get(reqId)?.(reply);
    };
    if (!isPresenter) {
      channel.postMessage({ kind: "hello" });
      channel.postMessage({ kind: "audience_join", viewer });
    } else {
      // A viewer window opened before this one: it asks again.
      channel.postMessage({ kind: "audience_resync" });
    }
    return () => {
      channel.close();
      host.setOutbound(() => {});
      host.history.setLink({}, false);
      host.audience.setLink(null);
    };
  }, [host, id, local, isPresenter]);

  // --- Settings ---
  // Plugins loaded from this browser's registry take their settings from this
  // browser's settings document; a shared deck's presenter also sends them on,
  // so viewers run with the presenter's values.
  const settingsDoc = useSettingsDocument();
  const sentSettingsRef = useRef(new Map<string, string>());
  useEffect(() => {
    if (fromSession) return;
    for (const { id: pluginId, manifest } of plugins) {
      const values = resolvePluginSettings(pluginId, manifest.contributes.settings, settingsDoc);
      host.setPluginSettings(pluginId, values);
      if (local !== false || !isPresenter || !socket.connected) continue;
      const json = JSON.stringify(values);
      if (sentSettingsRef.current.get(pluginId) === json) continue;
      sentSettingsRef.current.set(pluginId, json);
      socket.emit("plugin_settings", { plugin: pluginId, settings: values });
    }
  }, [host, plugins, settingsDoc, fromSession, local, isPresenter]);

  // --- Viewers that couldn't load a plugin ---
  // Viewers report once per plugin version; the presenter keeps who failed
  // and why, per plugin id, for the version it published.
  const [loadFailures, setLoadFailures] = useState<Record<string, { hash: string; senders: Record<string, string> }>>({});
  const reportedRef = useRef(new Set<string>());

  // --- Shared deck: the session's socket ---
  const publishRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (local !== false) return;
    // A volatile message (a laser position) is dropped rather than queued
    // while the socket can't take it: a late one is worse than none.
    host.setOutbound((event) => (event.volatile ? socket.volatile : socket).emit("plugin_event", event));

    // Histories: the server orders edits (server/history.ts); blobs go over
    // HTTP. The link is ready once the socket has joined (plugins_state).
    const historyLink = sharedHistoryLink(id, isPresenter, (sha) => host.history.getBlob(sha));
    const onHistoryEntry = ({ plugin, entry }: { plugin: string; entry: HistoryEntry }) => host.history.receive(plugin, entry);
    const onHistoryReset = ({ plugin }: { plugin: string }) => host.history.receiveReset(plugin);
    const onDisconnect = () => host.history.setLink(historyLink, false);

    // Audience input: the server holds the slots. The presenter mirrors them
    // and, on (re)joining, merges its copy into the server's and adopts the
    // result; a viewer gets back its key states and its own values.
    host.audience.setLink(sharedAudienceLink());
    const viewer = audienceViewerId(id);
    const joinAudience = () => {
      askAudience<{ plugins: AudienceJoin }>("audience_join", { viewer }).then(
        (reply) => host.audience.receiveJoin(reply.plugins),
        (e) => console.warn("Couldn't join the audience:", e)
      );
    };
    const seedAudience = async () => {
      for (const { id: plugin, manifest } of pluginsRef.current) {
        if (!collectsAudience(manifest)) continue;
        try {
          for (const keys of seedParts(host.audience.mirrorOf(plugin))) {
            if (Object.keys(keys).length) await askAudience("audience_seed", { plugin, keys });
          }
          const reply = await askAudience<{ keys: Record<string, AudienceKeyState> }>("audience_pull", { plugin });
          host.audience.adopt(plugin, reply.keys);
        } catch (e) {
          console.warn(`Couldn't sync ${plugin}'s audience input:`, e);
        }
      }
    };
    const onAudienceUpdate = (u: { plugin: string; key: string; summary: AudienceSummary; changes: Record<string, unknown> }) =>
      host.audience.receiveUpdate(u.plugin, u.key, u.summary, u.changes);
    const onAudienceState = ({ plugin, key, open }: { plugin: string; key: string; open: boolean }) =>
      host.audience.receiveKeyState(plugin, key, open);
    const onAudienceCleared = ({ plugin, key }: { plugin: string; key: string }) => host.audience.receiveCleared(plugin, key);
    const onAudienceResync = () => {
      if (!isPresenter) joinAudience();
    };

    // Only where to find each plugin: viewers load it themselves (cached like
    // any web page), never through the server.
    const publish = () => {
      const plugins = pluginsRef.current
        .filter((p) => runsOnViewers(p.manifest))
        .map(({ id, manifest, url, hash }): PublishedPlugin => ({
          id,
          manifest: {
            name: manifest.name,
            displayName: manifest.displayName,
            version: manifest.version,
            author: manifest.author,
            description: manifest.description,
            surfaces: manifest.surfaces,
            permissions: manifest.permissions,
          },
          url,
          hash,
        }));
      socket.emit("plugins_publish", { plugins });
      if (isPresenter) void seedAudience();
    };

    const onEvent = (event: WireEvent) => host.receive(event);
    const onSettings = (update: SettingsUpdate) => {
      if (!isPresenter) host.setPluginSettings(update.plugin, update.settings);
    };

    const onState = async (state: PluginsState) => {
      historyLink.retryUploads();
      host.history.setLink(historyLink, true);
      if (isPresenter) {
        // The server's copy can lag ours (it restarted, or we changed plugins
        // before joining): republish, and re-seed retained state it lost.
        const server = new Map(state.plugins.map((p) => [p.id, p.hash]));
        const ours = pluginsRef.current.filter((p) => runsOnViewers(p.manifest));
        const stale = ours.length !== server.size || ours.some((p) => server.get(p.id) !== p.hash);
        if (stale) publish();
        else void seedAudience();
        // Retained state is merged both ways: ours goes up where the server
        // has none, and a reloaded controller adopts what the server kept.
        const onServer = new Set(state.retained.map(retainKey));
        const ourKeys = new Set(host.retainedEvents().map(retainKey));
        for (const event of host.retainedEvents()) {
          if (!onServer.has(retainKey(event))) socket.emit("plugin_event", event);
        }
        host.seedRetained(state.retained.filter((e) => !ourKeys.has(retainKey(e))));
        // And our settings, which the server may not have (or had from an
        // earlier controller).
        sentSettingsRef.current.clear();
        for (const { id: pluginId, manifest } of pluginsRef.current) {
          const values = resolvePluginSettings(pluginId, manifest.contributes.settings);
          sentSettingsRef.current.set(pluginId, JSON.stringify(values));
          socket.emit("plugin_settings", { plugin: pluginId, settings: values });
        }
        return;
      }
      joinAudience();
      for (const [plugin, values] of Object.entries(state.settings ?? {})) host.setPluginSettings(plugin, values);
      host.seedRetained(state.retained);
      // Fetch only what changed; the watchdog re-joins every 30s.
      const current = new Map(pluginsRef.current.map((p) => [p.id, p]));
      const next: LoadedPlugin[] = [];
      for (const { id, url, hash } of state.plugins) {
        const have = current.get(id);
        if (have?.hash === hash) {
          next.push(have);
          continue;
        }
        try {
          const loaded = await loadPlugin(url, { expectedHash: hash });
          // The id comes from where it's loaded from; the presenter's says the same.
          if (loaded.id !== id) throw new Error(`it loaded as "${loaded.id}", not "${id}"`);
          // Run as published: the deck already activated it there, and its
          // settings arrive as the presenter's values.
          next.push({ ...loaded, manifest: { ...loaded.manifest, activation: ["always"] } });
        } catch (e) {
          // Unreachable from here (a presenter's localhost dev server), or
          // changed since: this viewer goes without it, and says so to the
          // presenter (once per version: the watchdog re-joins every 30s).
          console.warn(`Plugin ${id} not loaded:`, e);
          const key = `${id}:${hash}`;
          if (!reportedRef.current.has(key)) {
            reportedRef.current.add(key);
            socket.emit("plugin_load_failed", { plugin: id, hash, reason: loadFailureReason(e, url) });
          }
        }
      }
      const changed =
        next.length !== pluginsRef.current.length || next.some((p, i) => p !== pluginsRef.current[i]);
      if (changed) setSessionPlugins(next);
    };

    const onLoadFailed = (failure: LoadFailure) => {
      if (!isPresenter) return;
      setLoadFailures((prev) => {
        const current = prev[failure.plugin]?.hash === failure.hash ? prev[failure.plugin].senders : {};
        return { ...prev, [failure.plugin]: { hash: failure.hash, senders: { ...current, [failure.sender]: failure.reason } } };
      });
    };

    socket.on("plugin_event", onEvent);
    socket.on("plugin_settings", onSettings);
    socket.on("plugins_state", onState);
    socket.on("plugin_load_failed", onLoadFailed);
    socket.on("history_entry", onHistoryEntry);
    socket.on("history_reset", onHistoryReset);
    socket.on("disconnect", onDisconnect);
    socket.on("audience_update", onAudienceUpdate);
    socket.on("audience_state", onAudienceState);
    socket.on("audience_cleared", onAudienceCleared);
    socket.on("audience_resync", onAudienceResync);
    publishRef.current = publish;
    return () => {
      socket.off("plugin_event", onEvent);
      socket.off("plugin_settings", onSettings);
      socket.off("plugins_state", onState);
      socket.off("plugin_load_failed", onLoadFailed);
      socket.off("history_entry", onHistoryEntry);
      socket.off("history_reset", onHistoryReset);
      socket.off("disconnect", onDisconnect);
      socket.off("audience_update", onAudienceUpdate);
      socket.off("audience_state", onAudienceState);
      socket.off("audience_cleared", onAudienceCleared);
      socket.off("audience_resync", onAudienceResync);
      host.setOutbound(() => {});
      host.history.setLink({}, false);
      host.audience.setLink(null);
      publishRef.current = null;
    };
  }, [host, id, local, isPresenter]);

  // Republish when the presenter's own set changes mid-session (a plugin
  // switched on in Settings). Until something has been published, an empty
  // set is just "still loading" — publishing it would wipe what the server
  // kept across a controller reload; the join's plugins_state reply covers
  // the first publish.
  const publishKey = plugins
    .filter((p) => runsOnViewers(p.manifest))
    .map((p) => `${p.id}:${p.hash}`)
    .join(",");
  const publishedOnceRef = useRef(false);
  useEffect(() => {
    if (local !== false || !isPresenter || !socket.connected) return;
    if (!publishKey && !publishedOnceRef.current) return;
    publishedOnceRef.current = true;
    publishRef.current?.();
  }, [publishKey, local, isPresenter]);

  // Only failures for the version running now: a fix republishes a new hash.
  const viewerErrors: Record<string, string> = {};
  for (const plugin of plugins) {
    const failure = loadFailures[plugin.id];
    if (!failure || failure.hash !== plugin.hash) continue;
    const reasons = Object.values(failure.senders);
    if (!reasons.length) continue;
    const n = reasons.length;
    viewerErrors[plugin.key] = `${n} viewer${n === 1 ? "" : "s"} couldn't load it: ${reasons[0]}`;
  }

  return { host, plugins, errors: localActive.errors, viewerErrors };
}
