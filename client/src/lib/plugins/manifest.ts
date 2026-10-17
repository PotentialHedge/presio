// Plugin manifests, as the app uses them. The format and its validator are
// shared with the server and the plugin checker (shared/plugin/manifest.ts);
// this adds what only the app has: a plugin loaded and ready to mount.

export * from "@shared/plugin/manifest";
import type { PluginManifest } from "@shared/plugin/manifest";

/** A plugin ready to mount: its id, manifest and HTML. */
export interface LoadedPlugin {
  /** Derived from its source (shared/plugin/sources.ts): "presio/timer",
   *  "alice/poll", "url:localhost:5174/demo". */
  id: string;
  /** The key it's registered under (the "plugins" setting): its source, as
   *  written canonically. A viewer's plugins are keyed by URL. */
  key: string;
  manifest: PluginManifest;
  /** Where it was loaded from, as registered: a path on this origin for
   *  built-ins (so viewers load them from theirs), or an absolute URL. */
  url: string;
  /** The same, absolute: the base its relative URLs resolve against. */
  baseUrl: string;
  html: string;
  /** SHA-256 of `html`: what viewers check what they load against. */
  hash: string;
}

/** An untrusted value as an object to read fields from ({} when it isn't one). */
export function asRecord(value: unknown): Record<string, unknown> {
  return (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
}
