// What the presenter has agreed to run.
//
// Trust is granted per plugin (its source without the version: the repo, or
// the URL) and per permission set, remembering the version and dependencies
// it was granted for. A later version in the same major, or a dev branch's
// next commit, runs without asking as long as it asks for nothing more; new
// permissions, a new major or a new dependency ask again, saying what
// changed. Built-ins are trusted as part of Presio.

import { lsGet, lsSet } from "@/lib/storage";
import { isBreaking } from "@shared/plugin/refs";
import type { PluginPermission } from "./manifest";
import { resolvedChain, sourceKey, type Resolution, type ResolvedPlugin } from "./resolve";
import { parseSource } from "@shared/plugin/sources";

/** localStorage: { [source key]: TrustRecord }. */
const TRUST_KEY = "presio_plugin_trust";

interface TrustRecord {
  permissions: PluginPermission[];
  /** The manifest version it was granted for. */
  version: string;
  /** Its dependencies' source keys. */
  dependencies: string[];
  /** When (ms). */
  at: number;
}

/** How a plugin differs from what was trusted; null when it doesn't. */
export interface TrustChange {
  /** Never trusted before. */
  first: boolean;
  /** Permissions it asks for that weren't granted. */
  permissions: PluginPermission[];
  /** A breaking version since the one trusted. */
  major: { from: string; to: string } | null;
  /** Dependencies it didn't have (source keys). */
  dependencies: string[];
}

const dependencyKeys = (r: ResolvedPlugin) =>
  Object.keys(r.plugin?.manifest.dependencies ?? {}).flatMap((spec) => {
    try {
      return [sourceKey(parseSource(spec))];
    } catch {
      return [];
    }
  });

/** What changed since this plugin was trusted (null: nothing that needs asking). */
export function trustChange(r: ResolvedPlugin): TrustChange | null {
  if (r.source.kind === "builtin" || !r.plugin) return null;
  const record = lsGet<Record<string, TrustRecord>>(TRUST_KEY, {})[r.key];
  const { manifest } = r.plugin;
  if (!record) return { first: true, permissions: manifest.permissions, major: null, dependencies: dependencyKeys(r) };
  const permissions = manifest.permissions.filter((p) => !record.permissions.includes(p));
  const major = isBreaking(record.version, manifest.version) ? { from: record.version, to: manifest.version } : null;
  const dependencies = dependencyKeys(r).filter((d) => !record.dependencies.includes(d));
  return permissions.length || major || dependencies.length ? { first: false, permissions, major, dependencies } : null;
}

/** Whether running this resolution needs the presenter's say first. */
export function needsApproval(resolution: Resolution): boolean {
  return resolvedChain(resolution).some((r) => trustChange(r) !== null);
}

/** Record trust in these plugins as they are now. */
export function grantTrust(plugins: readonly ResolvedPlugin[]) {
  const all = lsGet<Record<string, TrustRecord>>(TRUST_KEY, {});
  for (const r of plugins) {
    if (!r.plugin || r.source.kind === "builtin") continue;
    const before = all[r.key];
    all[r.key] = {
      // Granted permissions accumulate: dropping one and asking again later
      // isn't new.
      permissions: [...new Set([...(before?.permissions ?? []), ...r.plugin.manifest.permissions])],
      version: r.plugin.manifest.version,
      dependencies: [...new Set([...(before?.dependencies ?? []), ...dependencyKeys(r)])],
      at: Date.now(),
    };
  }
  lsSet(TRUST_KEY, all);
}
