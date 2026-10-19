// Wires a PluginHost into a running presentation: which plugins are active on
// this device, and the transport their messages travel over (localChannel.ts
// for a local deck, usePluginSocket.ts for a shared one).
//
// The presenter decides what runs. It activates its enabled plugins against the
// deck and, for a shared deck, publishes the ones with a viewer surface to the
// session so audience devices run exactly those — viewers never install
// anything. A local deck's viewer window is in the same browser, so it reads
// the same registry and syncs over a BroadcastChannel instead.

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { socket } from "@/lib/socket";
import { useJoinUrl } from "@/lib/joinUrl";
import { PluginHost, type PluginContext } from "./host";
import type { LoadedPlugin } from "./manifest";
import { loadEntries, usePluginEntries, useSessionPluginRelay } from "./registry";
import { clockOffset, onClockSample } from "@/lib/clock";
import { resolvePluginSettings, useSettingsDocument } from "@/lib/settings";
import { useResolvedTheme } from "@/hooks/useResolvedTheme";
import { useAttachmentNamesReader, useAttachmentReader, useBytesReader, usePagesReader } from "./deckReaders";
import { useLocalPluginChannel } from "./localChannel";
import { usePluginSocket } from "./usePluginSocket";

/** Enabled plugins from this browser's registry (installed, or loaded for
 *  this tab) that the deck activates, with what they depend on. */
function useLocallyActivePlugins(enabled: boolean, readNames: () => Promise<string[]>) {
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
      const names = await readNames();
      const { plugins: loaded, errors: failed } = await loadEntries(entriesRef.current, names);
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
  }, [enabled, entriesKey, readNames]);

  return { plugins: enabled ? plugins : [], errors };
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
  const theme = useResolvedTheme();
  const join = useJoinUrl(id, "viewer");
  const ctx: PluginContext = {
    role: isPresenter ? "presenter" : "audience",
    theme,
    session: { id, local: !!local, joinUrl: local ? null : join.url },
    slide: { current: currentSlide, total: totalSlides },
  };
  const [host] = useState(() => new PluginHost(ctx));
  useEffect(() => {
    host.attach();
    return () => host.dispose();
  }, [host]);
  useEffect(() => {
    host.updateContext(ctx);
  });

  const readAll = useAttachmentReader(pdf);
  const readBytes = useBytesReader(pdf);
  const readPages = usePagesReader(pdf);
  const readNames = useAttachmentNamesReader(pdf);
  useEffect(() => host.setDeckSource(readAll, readBytes, readPages), [host, readAll, readBytes, readPages]);

  // Server viewers get their plugin list from the session; everyone else
  // (the presenter, and a local deck's viewer window) from this browser.
  const fromSession = local === false && !isPresenter;
  useSessionPluginRelay(id, local, isPresenter);
  const localActive = useLocallyActivePlugins(local !== null && !fromSession, readNames);
  const [sessionPlugins, setSessionPlugins] = useState<LoadedPlugin[]>([]);
  const plugins = fromSession ? sessionPlugins : localActive.plugins;

  // Static layers belong to running plugins only, and downloads pass through
  // them in this order.
  const runningIds = plugins.map((p) => p.id).join(",");
  useEffect(() => host.setRunning(runningIds ? runningIds.split(",") : []), [host, runningIds]);

  // Plugins keep their own copy of the server clock (presio.clock).
  useEffect(() => onClockSample(() => host.setClockOffset(clockOffset())), [host]);

  useLocalPluginChannel(host, id, local, isPresenter);

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

  // --- Shared deck: the session's socket ---
  const { viewerErrors } = usePluginSocket({ host, id, local, isPresenter, plugins, setSessionPlugins, sentSettingsRef });

  return { host, plugins, errors: localActive.errors, viewerErrors };
}
