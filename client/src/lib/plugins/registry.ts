// The presenter's installed plugins: which exist and which are switched on
// (the "plugins" setting).
//
// A plugin is registered by its source (shared/plugin/sources.ts), written
// canonically: "presio/timer" for a built-in, "github:alice/presio-poll@v1.0.0"
// for one on GitHub, its URL for one served anywhere else — typically the
// presenter's own dev server while building one. Each entry carries the URL
// it loads from and the id its source gives it. Nothing runs until a plugin is
// both enabled here and activated by the deck on screen.

import { useMemo } from "react";
import { getSetting, setSetting, useSetting, type CoreSettings } from "@/lib/settings";
import { sha256Hex } from "@/lib/analytics";
import {
  BUILTIN_SCOPE,
  formatSource,
  parseSource,
  pluginIdOf,
  type PluginSource,
} from "@shared/plugin/sources";
import { parseManifest, type LoadedPlugin } from "./manifest";

export interface PluginEntry {
  /** Its source, written canonically: the key it's stored under. */
  key: string;
  source: PluginSource;
  /** Where it loads from: a path on this origin for built-ins, else an
   *  absolute base URL (ending in "/"). */
  url: string;
  /** Its id, once known (a URL plugin's needs its manifest). */
  id: string | null;
  enabled: boolean;
  builtin: boolean;
}

/** Shipped with the app, served at /plugins/<name>/, with whether each is on
 *  until the presenter says otherwise. All of them were core before plugins
 *  existed. Order is the order plugins' layers stack on a slide (later ones
 *  on top) and downloads pass through them. */
const BUILTINS: Record<string, { enabled: boolean }> = {
  timer: { enabled: true },
  notes: { enabled: true },
  media: { enabled: true },
  drawing: { enabled: true },
  "join-code": { enabled: true },
};

/** Where a built-in plugin is served. */
const builtinUrl = (name: string) => `/plugins/${name}/`;
const BUILTIN_URL_RE = /^\/plugins\/([a-z0-9-]+)\/$/;

/** The source a plugin URL stands for: a built-in's path, a GitHub repo
 *  served by jsDelivr, or the URL itself. */
export function sourceOfUrl(url: string): PluginSource {
  const builtin = BUILTIN_URL_RE.exec(url);
  if (builtin) return { kind: "builtin", name: builtin[1] };
  return parseSource(url);
}

// The "plugins" setting maps source -> { enabled, url, id }. Built-ins appear
// in it only once toggled; everything else is in it because it was added.
function entriesFrom(list: CoreSettings["plugins"]): PluginEntry[] {
  const builtins = Object.entries(BUILTINS).map(([name, { enabled }]): PluginEntry => {
    const source: PluginSource = { kind: "builtin", name };
    const key = formatSource(source);
    return { key, source, url: builtinUrl(name), id: pluginIdOf(source), enabled: list[key]?.enabled ?? enabled, builtin: true };
  });
  const added = Object.entries(list).flatMap(([key, entry]): PluginEntry[] => {
    if (builtins.some((b) => b.key === key) || !entry.url) return [];
    try {
      return [{ key, source: parseSource(key), url: entry.url, id: entry.id ?? null, enabled: entry.enabled, builtin: false }];
    } catch {
      return [];
    }
  });
  return [...builtins, ...added];
}

export function usePluginEntries(): PluginEntry[] {
  const [list] = useSetting("plugins");
  return useMemo(() => entriesFrom(list), [list]);
}

export function setPluginEnabled(key: string, enabled: boolean) {
  const list = getSetting("plugins");
  setSetting("plugins", { ...list, [key]: { ...list[key], enabled } });
}

export function removePlugin(key: string) {
  const list = { ...getSetting("plugins") };
  delete list[key];
  setSetting("plugins", list);
}

/**
 * Check a plugin URL against where this page may load plugins from: https
 * anywhere; plain http on this machine for a dev server, or anywhere when
 * Presio itself is on http (a local deployment, where a LAN address lets
 * phones reach the dev server too — an https page couldn't load it at all).
 */
function checkUrlPolicy(base: string) {
  const url = new URL(base);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const httpOk = loopback || window.location.protocol === "http:";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && httpOk)) {
    throw new Error("Plugin URLs must be https (or http on localhost)");
  }
}

/** Add (and enable) a plugin after checking its manifest loads. Returns the
 *  key it's now listed under, and the plugin. */
export async function addPlugin(input: string): Promise<{ key: string; plugin: LoadedPlugin }> {
  const source = parseSource(input);
  const key = formatSource(source);
  if (source.kind === "builtin") {
    if (!(source.name in BUILTINS)) throw new Error(`No built-in plugin "${BUILTIN_SCOPE}/${source.name}"`);
    setPluginEnabled(key, true);
    return { key, plugin: await loadPlugin(builtinUrl(source.name), { source, key }) };
  }
  if (source.kind === "url") checkUrlPolicy(source.url);
  const url = source.kind === "github" ? await gitHubPluginUrl(source) : source.url;
  let plugin: LoadedPlugin;
  try {
    plugin = await loadPlugin(url, { source, key });
  } catch (e) {
    if (source.kind !== "github" || !(e instanceof Error)) throw e;
    const where = source.path ? `${source.path}/` : "the repo's root";
    throw new Error(`${e.message}. Is presio-plugin.json at ${where}, in a public repo?`, { cause: e });
  }
  // One plugin per id: the id is its identity everywhere (settings, state).
  const taken = entriesFrom(getSetting("plugins")).find((e) => e.id === plugin.id && e.key !== key);
  if (taken) throw new Error(`"${plugin.id}" is installed already (from ${taken.key}); remove that one first`);
  setSetting("plugins", { ...getSetting("plugins"), [key]: { enabled: true, url, id: plugin.id } });
  return { key, plugin };
}

// --- Plugins on GitHub ---
//
// A plugin is just a repo: it's served by jsDelivr, which — unlike
// raw.githubusercontent.com — serves scripts with their real MIME type and
// CORS headers, so plugins split into several files work too. GitHub's own
// release downloads can't be fetched by a page at all (no CORS).
//
// The URL is always pinned: to the tag given, else the latest release (or
// tag), else — a branch, or a repo with no tags — the commit it points at
// now. Viewers load the plugin themselves and check it's byte for byte the
// presenter's; a branch URL, cached for hours by the CDN, could hand them a
// different version and they'd go without it.

const JSDELIVR_GH = "https://cdn.jsdelivr.net/gh/";

async function gitHubApi<T>(path: string): Promise<T | null> {
  const res = await fetch(`https://api.github.com/repos/${path}`, { headers: { Accept: "application/vnd.github+json" } });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(
      res.status === 403 || res.status === 429
        ? "GitHub's rate limit was hit looking up the plugin's version; add @<tag> to the URL, or try again later"
        : `Couldn't look up the plugin on GitHub (HTTP ${res.status})`
    );
  }
  return (await res.json()) as T;
}

/** The pinned jsDelivr URL for a plugin on GitHub (see above). */
export async function gitHubPluginUrl(source: Extract<PluginSource, { kind: "github" }>): Promise<string> {
  const { owner, repo, path } = source;
  const slug = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  let ref = source.ref;
  if (!ref) {
    const release = await gitHubApi<{ tag_name?: string }>(`${slug}/releases/latest`);
    ref = release?.tag_name;
    if (!ref) {
      const tags = await gitHubApi<{ name: string }[]>(`${slug}/tags?per_page=1`);
      ref = tags?.[0]?.name;
    }
    if (!ref) {
      const repoInfo = await gitHubApi<{ default_branch: string }>(slug);
      if (!repoInfo) throw new Error(`No public GitHub repo ${owner}/${repo}`);
      ref = repoInfo.default_branch;
    }
  }
  // A branch moves: pin the commit it's on now. Tags and commits stay put.
  // (Best effort when a ref was given: failing to ask isn't failing to add.)
  if (!/^[0-9a-f]{40}$/i.test(ref)) {
    const branch = await gitHubApi<{ commit: { sha: string } }>(`${slug}/branches/${encodeURIComponent(ref)}`).catch((e) => {
      if (source.ref) return null;
      throw e;
    });
    if (branch) ref = branch.commit.sha;
  }
  return `${JSDELIVR_GH}${owner}/${repo}@${ref}/${path ? `${path}/` : ""}`;
}

/** A plugin URL as people read it: "owner/repo@v1.2.0" for one from GitHub. */
export function describePluginUrl(url: string): string {
  const gh = /^https:\/\/cdn\.jsdelivr\.net\/gh\/([^/]+)\/([^/@]+)@([^/]+)\/(.*?)\/?$/.exec(url);
  if (gh) {
    const ref = /^[0-9a-f]{40}$/i.test(gh[3]) ? gh[3].slice(0, 7) : gh[3];
    return `${gh[1]}/${gh[2]}@${ref}${gh[4] ? `/${gh[4]}` : ""}`;
  }
  try {
    const u = new URL(url, window.location.href);
    return u.host + u.pathname.replace(/\/$/, "");
  } catch {
    return url;
  }
}

/**
 * Fetch a plugin's manifest and HTML, and give it its id. Always revalidated
 * rather than cached at install: a dev server's plugin should pick up edits
 * on the next load.
 *
 * `source` is what the id comes from (by default, what the URL stands for);
 * `key` what it's registered under (by default, the URL). `expectedHash` is
 * for viewers loading what the presenter published: the plugin only runs if
 * its HTML is the presenter's, byte for byte.
 */
export async function loadPlugin(
  url: string,
  opts: { source?: PluginSource; key?: string; expectedHash?: string } = {}
): Promise<LoadedPlugin> {
  const base = new URL(url, window.location.href);
  const res = await fetch(new URL("presio-plugin.json", base), { cache: "no-cache" });
  if (!res.ok) throw new Error(`Couldn't load presio-plugin.json (HTTP ${res.status})`);
  const manifest = parseManifest(await res.json().catch(() => {
    throw new Error("presio-plugin.json isn't valid JSON");
  }));
  const id = pluginIdOf(opts.source ?? sourceOfUrl(url), manifest.name);
  const htmlRes = await fetch(new URL(manifest.main, base), { cache: "no-cache" });
  if (!htmlRes.ok) throw new Error(`Couldn't load ${manifest.main} (HTTP ${htmlRes.status})`);
  const html = await htmlRes.text();
  const hash = await sha256Hex(new TextEncoder().encode(html).buffer as ArrayBuffer);
  if (opts.expectedHash && hash !== opts.expectedHash) throw new Error("This plugin changed since the presenter loaded it");
  return { id, key: opts.key ?? url, manifest, url, baseUrl: base.href, html, hash };
}
