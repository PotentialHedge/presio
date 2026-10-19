// A shared deck's plugin transport: the session's socket. The presenter
// publishes which plugins viewers run (where to load each, never the plugin
// itself) and keeps the server's copy of retained messages and settings in
// step; a viewer loads what's published and reports what it couldn't.

import { useEffect, useRef, useState } from "react";
import { socket } from "@/lib/socket";
import { resolvePluginSettings } from "@/lib/settings";
import type { AudienceJoin, AudienceKeyState, AudienceSummary } from "@shared/plugin/audience";
import { retainKey, audienceViewerId, type PluginHost, type WireEvent } from "./host";
import type { HistoryEntry } from "./history";
import type { LoadedPlugin, PluginManifest } from "./manifest";
import { loadPlugin } from "./resolve";
import { askAudience, collectsAudience, runsOnViewers, seedParts, sharedAudienceLink, sharedHistoryLink } from "./sharedLinks";

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

export function usePluginSocket({
  host,
  id,
  local,
  isPresenter,
  plugins,
  setSessionPlugins,
  sentSettingsRef,
}: {
  host: PluginHost;
  id: string;
  local: boolean | null;
  isPresenter: boolean;
  /** The plugins running on this device. */
  plugins: LoadedPlugin[];
  /** A viewer's plugins, as the session publishes them. */
  setSessionPlugins: (plugins: LoadedPlugin[]) => void;
  /** The settings last sent per plugin (shared with the settings effect). */
  sentSettingsRef: React.RefObject<Map<string, string>>;
}): { viewerErrors: Record<string, string> } {
  const pluginsRef = useRef(plugins);
  useEffect(() => { pluginsRef.current = plugins; });

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
    // Which viewer runs which plugin (presio.viewers): each viewer tells the
    // server, which tells the presenter.
    if (!isPresenter) host.viewers.setReport((plugins) => socket.emit("plugin_presence", { plugins }));
    const onViewers = ({ viewers }: { viewers: { plugin: string; viewer: string }[] }) => host.viewers.reset(viewers);
    const onViewer = ({ plugin, viewer, here }: { plugin: string; viewer: string; here: boolean }) => host.viewers.change(plugin, viewer, here);

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
      // A (re)join: the server may not know what runs here (it restarted).
      host.viewers.resend();
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
    socket.on("plugin_viewers", onViewers);
    socket.on("plugin_viewer", onViewer);
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
      socket.off("plugin_viewers", onViewers);
      socket.off("plugin_viewer", onViewer);
      host.viewers.setReport(null);
      host.setOutbound(() => {});
      host.history.setLink({}, false);
      host.audience.setLink(null);
      publishRef.current = null;
    };
  }, [host, id, local, isPresenter, sentSettingsRef, setSessionPlugins]);

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

  return { viewerErrors };
}
