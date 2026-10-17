// The presenter's installed plugins with their manifests loaded, for the
// Settings pages that list and describe them.

import { useEffect, useState } from "react";
import type { LoadedPlugin } from "./manifest";
import { describePluginUrl, loadPlugin, usePluginEntries, type PluginEntry } from "./registry";

export interface InstalledPlugin {
  entry: PluginEntry;
  /** Null until loaded, or when it failed to load. */
  plugin: LoadedPlugin | null;
  error: string;
}

/**
 * Installed plugins, loaded. `errors` are load failures the running
 * presentation saw (by entry key), which take precedence over this list's own.
 */
export function useInstalledPlugins(errors: Record<string, string>): InstalledPlugin[] {
  const entries = usePluginEntries();
  const [loaded, setLoaded] = useState<Record<string, LoadedPlugin | string>>({});

  const key = entries.map((e) => `${e.key}\n${e.url}`).join("\n\n");
  useEffect(() => {
    let cancelled = false;
    for (const entry of entries) {
      loadPlugin(entry.url, { source: entry.source, key: entry.key }).then(
        (p) => !cancelled && setLoaded((m) => ({ ...m, [entry.key]: p })),
        (e: Error) => !cancelled && setLoaded((m) => ({ ...m, [entry.key]: e.message }))
      );
    }
    return () => { cancelled = true; };
    // `key` stands for the entries' sources and URLs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return entries.map((entry) => {
    const info = loaded[entry.key];
    return {
      entry,
      plugin: typeof info === "object" ? info : null,
      error: errors[entry.key] ?? (typeof info === "string" ? info : ""),
    };
  });
}

/** A readable name before the manifest has loaded (or when it can't). */
export function pluginLabel({ entry, plugin }: InstalledPlugin): string {
  return plugin ? plugin.manifest.displayName : entry.builtin ? entry.key : describePluginUrl(entry.url);
}
