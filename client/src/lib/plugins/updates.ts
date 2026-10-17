// Keeping installed plugins up to date.
//
// Once per page load, each installed GitHub plugin on a release looks for a
// newer one in the same major (its repo's tags are cached for a day, so
// that's at most a lookup a day). One that asks for nothing new is installed
// without a word, and Settings → Plugins says "Updated to vX". One that
// wants more goes to the trust prompt. A new major is only offered, in
// Settings, with a button that prompts.

import { useSyncExternalStore } from "react";
import { getSetting } from "@/lib/settings";
import { lsGet, lsSet } from "@/lib/storage";
import { breakingUpdate, compatibleUpdate } from "@shared/plugin/refs";
import { parseVersion } from "@shared/plugin/semver";
import { formatSource, parseSource } from "@shared/plugin/sources";
import { installResolved } from "./registry";
import { repoTags, resolvedChain, resolveWithDependencies } from "./resolve";
import { grantTrust, needsApproval } from "./trust";
import { requestPlugin } from "./prompts";

/** localStorage: { [source key]: UpdateInfo }. */
const UPDATES_KEY = "presio_plugin_updates";

export interface UpdateInfo {
  /** The last update installed on its own. */
  updated?: { from: string; to: string; at: number };
  /** A newer major, waiting for the presenter. */
  available?: string;
  /** A compatible update the presenter skipped at the prompt: offered in
   *  Settings rather than asked about again. */
  skipped?: string;
}

let updates = lsGet<Record<string, UpdateInfo>>(UPDATES_KEY, {});
const listeners = new Set<() => void>();

function setUpdateInfo(key: string, info: UpdateInfo) {
  updates = { ...updates, [key]: info };
  lsSet(UPDATES_KEY, updates);
  listeners.forEach((l) => l());
}

/** What's known about a plugin's updates. */
export function useUpdateInfo(key: string): UpdateInfo | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => updates[key]
  );
}

/** A source key at a version, as a source. */
function atVersion(key: string, tag: string): string {
  const source = parseSource(key);
  return formatSource(source.kind === "github" ? { ...source, ref: tag } : source);
}

/** Ask for an update in the trust prompt (Settings' update button). */
export function promptUpdate(key: string, tag: string) {
  const from = getSetting("plugins")[key]?.ref ?? "";
  requestPlugin(atVersion(key, tag), {
    reason: "update",
    onDone: ({ choice }) => {
      if (choice === "install") setUpdateInfo(key, { updated: { from, to: tag, at: Date.now() } });
    },
  });
}

let checked = false;

/** Look for updates to the installed plugins, once per page load. */
export async function checkForUpdates() {
  if (checked) return;
  checked = true;
  for (const [key, entry] of Object.entries(getSetting("plugins"))) {
    if (!entry.ref || !parseVersion(entry.ref) || !entry.url) continue;
    try {
      const source = parseSource(key);
      if (source.kind !== "github") continue;
      const tags = await repoTags(source.owner, source.repo);
      const info: UpdateInfo = { ...updates[key], available: breakingUpdate(tags, entry.ref) ?? undefined };
      const next = compatibleUpdate(tags, entry.ref);
      if (next && info.skipped === next) info.available ??= next;
      setUpdateInfo(key, info);
      if (!next || info.skipped === next) continue;

      const resolution = await resolveWithDependencies({ ...source, ref: next });
      if (resolution.error) continue; // a broken release: stay where it is
      if (!needsApproval(resolution)) {
        installResolved(resolvedChain(resolution));
        grantTrust(resolvedChain(resolution));
        setUpdateInfo(key, { ...info, updated: { from: entry.ref, to: next, at: Date.now() } });
        continue;
      }
      const from = entry.ref;
      requestPlugin(atVersion(key, next), {
        reason: "update",
        resolution,
        onDone: ({ choice }) => {
          if (choice === "install") setUpdateInfo(key, { ...updates[key], skipped: undefined, updated: { from, to: next, at: Date.now() } });
          else setUpdateInfo(key, { ...updates[key], skipped: next });
        },
      });
    } catch (e) {
      console.warn(`Couldn't check ${key} for updates:`, e);
    }
  }
}
