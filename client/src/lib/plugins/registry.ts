// The presenter's plugins: which are installed and switched on (the "plugins"
// setting), which are loaded for this tab only, and loading them for a deck.
//
// A plugin is registered by its source without the version
// (shared/plugin/sources.ts, written canonically): "presio/timer" for a
// built-in, "github:alice/presio-poll" for one on GitHub, its URL for one
// served anywhere else — typically the presenter's own dev server while
// building one. Each entry carries the version it's on (`ref`: a tag, a
// branch, a commit), the URL it loads from and the id its source gives it.
// Nothing runs until a plugin is both enabled here and activated by the deck
// on screen.
//
// How a source becomes a URL is resolve.ts; what the presenter agreed to is
// trust.ts. A plugin "loaded once" (from a ?plugins= link) lives in this
// tab's sessionStorage instead of the setting, and otherwise runs exactly
// like an installed one — published to viewers included.

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { getSetting, setSetting, useSetting, type CoreSettings } from "@/lib/settings";
import { parseSource, pluginIdOf, type PluginSource } from "@shared/plugin/sources";
import { parseVersion } from "@shared/plugin/semver";
import { shortSha } from "@shared/plugin/refs";
import { isActivatedBy, type LoadedPlugin } from "./manifest";
import {
  BUILTINS,
  builtinUrl,
  loadPlugin,
  resolveSource,
  resolveWithDependencies,
  sourceKey,
  type ResolvedPlugin,
} from "./resolve";
import { trustChange } from "./trust";
import { requestPlugin } from "./prompts";

export interface PluginEntry {
  /** Its source without the version, written canonically: the key it's stored under. */
  key: string;
  /** Its source, with the version it's on as the ref. */
  source: PluginSource;
  /** Where it loads from: a path on this origin for built-ins, else an
   *  absolute base URL (ending in "/"). */
  url: string;
  /** Its id, once known (a URL plugin's needs its manifest). */
  id: string | null;
  enabled: boolean;
  builtin: boolean;
  /** Loaded for this tab only ("Load once"), not installed. */
  session: boolean;
}

type StoredEntry = CoreSettings["plugins"][string];

// --- This tab's plugins ("Load once") ---

/** sessionStorage: this tab's plugins, as the "plugins" setting stores them. */
const SESSION_KEY = "presio_plugins_session";

function readSession(): Record<string, StoredEntry> {
  try {
    const raw = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "{}");
    return typeof raw === "object" && raw !== null ? raw : {};
  } catch {
    return {};
  }
}

let sessionList = readSession();
const sessionListeners = new Set<() => void>();

function setSessionList(next: Record<string, StoredEntry>) {
  sessionList = next;
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: this page keeps them in memory */
  }
  sessionListeners.forEach((l) => l());
}

const subscribeSession = (listener: () => void) => {
  sessionListeners.add(listener);
  return () => void sessionListeners.delete(listener);
};

// --- Entries ---

const withRef = (source: PluginSource, ref: string | undefined): PluginSource =>
  source.kind === "github" ? { ...source, ref } : source;

// The "plugins" setting maps source -> { enabled, url, id, ref }. Built-ins
// appear in it only once toggled; everything else is in it because it was
// installed. This tab's plugins come last, unless installed as well.
function entriesFrom(list: CoreSettings["plugins"], session: Record<string, StoredEntry>): PluginEntry[] {
  const builtins = Object.entries(BUILTINS).map(([name, { enabled }]): PluginEntry => {
    const source: PluginSource = { kind: "builtin", name };
    const key = sourceKey(source);
    const on = list[key]?.enabled ?? session[key]?.enabled ?? enabled;
    return { key, source, url: builtinUrl(name), id: pluginIdOf(source), enabled: on, builtin: true, session: false };
  });
  const from = (stored: Record<string, StoredEntry>, isSession: boolean) =>
    Object.entries(stored).flatMap(([key, entry]): PluginEntry[] => {
      if (builtins.some((b) => b.key === key) || !entry.url) return [];
      if (isSession && key in list) return [];
      try {
        const source = withRef(parseSource(key), entry.ref);
        return [{ key, source, url: entry.url, id: entry.id ?? null, enabled: entry.enabled, builtin: false, session: isSession }];
      } catch {
        return [];
      }
    });
  return [...builtins, ...from(list, false), ...from(session, true)];
}

export function usePluginEntries(): PluginEntry[] {
  const [list] = useSetting("plugins");
  const session = useSyncExternalStore(subscribeSession, () => sessionList);
  return useMemo(() => entriesFrom(list, session), [list, session]);
}

/** The entry a key stands for now, if any. */
export function findEntry(key: string): PluginEntry | undefined {
  return entriesFrom(getSetting("plugins"), sessionList).find((e) => e.key === key);
}

export function setPluginEnabled(key: string, enabled: boolean) {
  const list = getSetting("plugins");
  if (!(key in list) && key in sessionList) {
    setSessionList({ ...sessionList, [key]: { ...sessionList[key], enabled } });
    return;
  }
  setSetting("plugins", { ...list, [key]: { ...list[key], enabled } });
}

export function removePlugin(key: string) {
  const list = { ...getSetting("plugins") };
  delete list[key];
  setSetting("plugins", list);
  if (key in sessionList) {
    const session = { ...sessionList };
    delete session[key];
    setSessionList(session);
  }
}

const stored = (r: ResolvedPlugin): StoredEntry => ({ enabled: true, url: r.url!, id: r.plugin!.id, ...(r.ref && { ref: r.ref }) });

/** One plugin per id: the id is its identity everywhere (settings, state). */
function checkIdFree(plugins: readonly ResolvedPlugin[]) {
  const entries = entriesFrom(getSetting("plugins"), sessionList);
  for (const r of plugins) {
    const taken = entries.find((e) => e.id === r.plugin?.id && e.key !== r.key);
    if (taken) throw new Error(`"${r.plugin!.id}" is installed already (from ${taken.key}); remove that one first`);
  }
}

/** Install (and enable) resolved plugins: dependencies first, as
 *  resolvedChain orders them, so they load first. */
export function installResolved(plugins: readonly ResolvedPlugin[]) {
  checkIdFree(plugins);
  const list = { ...getSetting("plugins") };
  const session = { ...sessionList };
  for (const r of plugins) {
    if (!r.plugin || !r.url) continue;
    list[r.key] = r.source.kind === "builtin" ? { ...list[r.key], enabled: true } : stored(r);
    delete session[r.key];
  }
  setSetting("plugins", list);
  if (Object.keys(session).length !== Object.keys(sessionList).length) setSessionList(session);
}

/** Run resolved plugins in this tab only. Installed ones (dependencies
 *  already there) are switched on and otherwise left as they are. */
export function loadResolvedOnce(plugins: readonly ResolvedPlugin[]) {
  checkIdFree(plugins);
  const list = getSetting("plugins");
  const session = { ...sessionList };
  for (const r of plugins) {
    if (!r.plugin || !r.url) continue;
    if (r.key in list || r.source.kind === "builtin") {
      if (!findEntry(r.key)?.enabled) setPluginEnabled(r.key, true);
      continue;
    }
    session[r.key] = stored(r);
  }
  setSessionList(session);
}

// --- Loading for a deck ---

/** A ref that names a branch: dev mode, re-resolved on every load. */
function isDevRef(ref: string | undefined): boolean {
  return !!ref && !parseVersion(ref) && !/^[0-9a-f]{40}$/i.test(ref);
}

/**
 * Load an entry's plugin. A dev branch is looked up again (its newest
 * commit, once per page load) and runs without asking unless it now wants
 * more than was approved: then it waits on the trust prompt.
 */
export async function loadEntry(entry: PluginEntry): Promise<LoadedPlugin> {
  if (entry.source.kind === "github" && isDevRef(entry.source.ref)) {
    const resolved = await resolveSource(entry.source);
    if (resolved.error) throw new Error(resolved.error.message);
    if (trustChange(resolved)) {
      const resolution = await resolveWithDependencies(entry.source);
      requestPlugin(entry.key, { reason: "dev", resolution });
      throw new Error("Its latest commit asks for more than you approved: waiting for your approval");
    }
    return { ...resolved.plugin!, key: entry.key };
  }
  return loadPlugin(entry.url, { source: entry.source, key: entry.key });
}

/** The loaded plugin a dependency spec names, if it's among these. */
function findDependency<T extends { key: string; id: string | null }>(spec: string, plugins: readonly T[]): T | undefined {
  try {
    const source = parseSource(spec);
    const key = sourceKey(source);
    const id = source.kind === "url" ? null : pluginIdOf(source);
    return plugins.find((p) => p.key === key || (id !== null && p.id === id));
  } catch {
    return undefined;
  }
}

/**
 * Load enabled entries for a deck with these attachments: the plugins it
 * activates, each with what it depends on, dependencies first. A plugin
 * whose dependency isn't there doesn't run, and says why. Failures are by
 * entry key.
 */
export async function loadEntries(
  entries: readonly PluginEntry[],
  attachmentNames: readonly string[]
): Promise<{ plugins: LoadedPlugin[]; errors: Record<string, string> }> {
  const errors: Record<string, string> = {};
  let loaded: LoadedPlugin[] = [];
  for (const entry of entries) {
    try {
      const plugin = await loadEntry(entry);
      // Ids come from sources, so two entries only share one if the same
      // plugin was added twice (as a URL and as GitHub): the first runs.
      if (!loaded.some((p) => p.id === plugin.id)) loaded.push(plugin);
    } catch (e) {
      errors[entry.key] = e instanceof Error ? e.message : String(e);
    }
  }

  // Drop plugins missing a dependency, until none are (a drop can strand another).
  for (let dropped = true; dropped; ) {
    dropped = false;
    for (const plugin of loaded) {
      const missing = Object.keys(plugin.manifest.dependencies).find((spec) => !findDependency(spec, loaded));
      if (!missing) continue;
      const why = findDependency(missing, entries.map((e) => ({ key: e.key, id: e.id }))) ? "didn't load" : "isn't installed or is switched off";
      errors[plugin.key] = `Needs ${missing} ${plugin.manifest.dependencies[missing]}, which ${why}`;
      loaded = loaded.filter((p) => p !== plugin);
      dropped = true;
    }
  }

  // What the deck activates, each after what it needs; otherwise in the
  // registry's order (layers stack in it).
  const ordered: LoadedPlugin[] = [];
  const visiting = new Set<LoadedPlugin>();
  const add = (plugin: LoadedPlugin) => {
    if (visiting.has(plugin)) return; // done, or a cycle closing
    visiting.add(plugin);
    for (const spec of Object.keys(plugin.manifest.dependencies)) {
      const dep = findDependency(spec, loaded);
      if (dep) add(dep);
    }
    ordered.push(plugin);
  };
  for (const plugin of loaded) if (isActivatedBy(plugin.manifest, attachmentNames)) add(plugin);
  return { plugins: ordered, errors };
}

// --- Describing ---

/** Where an entry comes from and which version, as people read it:
 *  "alice/presio-poll v1.2.0", "main@abc1234", "localhost:5174/demo (unpinned)". */
export function describeEntry(entry: PluginEntry): string {
  const { source } = entry;
  if (source.kind === "builtin") return "built in";
  if (source.kind === "url") return `${describePluginUrl(entry.url)} (unpinned)`;
  const repo = `${source.owner}/${source.repo}${source.path ? `/${source.path}` : ""}`;
  const ref = source.ref;
  if (!ref) return repo;
  if (isDevRef(ref)) {
    const sha = /@([0-9a-f]{40})\//i.exec(entry.url)?.[1];
    return `${repo} ${ref}${sha ? `@${shortSha(sha)}` : ""} (dev)`;
  }
  return `${repo} ${/^[0-9a-f]{40}$/i.test(ref) ? shortSha(ref) : ref}`;
}

/** A plugin URL as people read it: "owner/repo@v1.2.0" for one from GitHub. */
export function describePluginUrl(url: string): string {
  const gh = /^https:\/\/cdn\.jsdelivr\.net\/gh\/([^/]+)\/([^/@]+)@([^/]+)\/(.*?)\/?$/.exec(url);
  if (gh) {
    const ref = /^[0-9a-f]{40}$/i.test(gh[3]) ? shortSha(gh[3]) : gh[3];
    return `${gh[1]}/${gh[2]}@${ref}${gh[4] ? `/${gh[4]}` : ""}`;
  }
  try {
    const u = new URL(url, window.location.href);
    return u.host + u.pathname.replace(/\/$/, "");
  } catch {
    return url;
  }
}

// --- A local deck's viewer window ---

/**
 * A local deck's viewer window runs the presenter tab's plugins, from this
 * browser. Installed ones it reads from the setting like the presenter; this
 * tab's own ("Load once") are in the presenter tab's sessionStorage, which a
 * window only gets a copy of when it's opened — so the presenter tab sends
 * them over, and again whenever they change.
 */
export function useSessionPluginRelay(id: string, local: boolean | null, isPresenter: boolean) {
  useEffect(() => {
    if (local !== true) return;
    const channel = new BroadcastChannel(`presio-session-plugins-${id}`);
    if (isPresenter) {
      const send = () => channel.postMessage({ kind: "list", list: sessionList });
      channel.onmessage = (e) => e.data?.kind === "hello" && send();
      const unsubscribe = subscribeSession(send);
      send();
      return () => {
        unsubscribe();
        channel.close();
      };
    }
    channel.onmessage = (e) => {
      if (e.data?.kind === "list" && typeof e.data.list === "object") setSessionList(e.data.list);
    };
    channel.postMessage({ kind: "hello" });
    return () => channel.close();
  }, [id, local, isPresenter]);
}
