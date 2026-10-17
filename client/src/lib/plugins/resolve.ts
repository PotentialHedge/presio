// From a plugin's source to the plugin, ready to run: which version, where to
// load it from, and what it is.
//
// Everything happens here in the browser, against the GitHub API (which
// allows any origin, at 60 requests an hour per address without a token) —
// the Presio server never fetches or inspects a plugin (it only lists the
// published ones, see lib/plugins/discover.ts). A repo's details and
// tags are cached in localStorage for a day; a branch's newest commit is
// looked up once per page load, so dev mode picks up a push on reload.
//
// A plugin on GitHub runs from jsDelivr pinned to a commit
// (cdn.jsdelivr.net/gh/<owner>/<repo>@<sha>/<path>/): content at a commit
// never changes, so that pin is its integrity check, and viewers get exactly
// what the presenter approved. The tag it was picked by is what people see.
// jsDelivr — unlike raw.githubusercontent.com — serves files with their real
// MIME type and CORS headers, so a plugin can be split into several files.
//
// Any other URL (a dev server on localhost, any https host) is "unpinned":
// viewers check the HTML they load hashes the same as the presenter's.

import { sha256Hex } from "@/lib/analytics";
import { lsGet, lsSet } from "@/lib/storage";
import { formatSource, parseSource, pluginIdOf, type PluginSource } from "@shared/plugin/sources";
import { isReleaseTag, parseRefSpec, pickTag, shortSha } from "@shared/plugin/refs";
import { validateManifest, type LoadedPlugin } from "./manifest";

// --- Built-ins ---

/** Shipped with the app, served at /plugins/<name>/, with whether each is on
 *  until the presenter says otherwise. All of them were core before plugins
 *  existed. Order is the order plugins' layers stack on a slide (later ones
 *  on top) and downloads pass through them. */
export const BUILTINS: Record<string, { enabled: boolean }> = {
  timer: { enabled: true },
  notes: { enabled: true },
  media: { enabled: true },
  drawing: { enabled: true },
  "join-code": { enabled: false },
};

/** Where a built-in plugin is served. */
export const builtinUrl = (name: string) => `/plugins/${name}/`;
const BUILTIN_URL_RE = /^\/plugins\/([a-z0-9-]+)\/$/;

/** The source a plugin URL stands for: a built-in's path, a GitHub repo
 *  served by jsDelivr, or the URL itself. */
export function sourceOfUrl(url: string): PluginSource {
  const builtin = BUILTIN_URL_RE.exec(url);
  if (builtin) return { kind: "builtin", name: builtin[1] };
  return parseSource(url);
}

/** A source without its version: what a plugin is installed and trusted
 *  under ("github:alice/presio-poll", a URL, "presio/timer"). */
export function sourceKey(source: PluginSource): string {
  return formatSource(source.kind === "github" ? { ...source, ref: undefined } : source);
}

// --- Loading a plugin from where it's served ---

/** A plugin that didn't load, with each problem on its own line (a manifest
 *  can have several). */
export class PluginLoadError extends Error {
  /** The message without the details. */
  summary: string;
  details: string[];
  constructor(summary: string, details: string[] = []) {
    super(details.length ? `${summary}: ${details.join("; ")}` : summary);
    this.summary = summary;
    this.details = details;
  }
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
  if (!res.ok) throw new PluginLoadError(`Couldn't load presio-plugin.json (HTTP ${res.status})`);
  const raw = await res.json().catch(() => {
    throw new PluginLoadError("presio-plugin.json isn't valid JSON");
  });
  const report = validateManifest(raw);
  if (!report.manifest) throw new PluginLoadError("presio-plugin.json isn't valid", report.errors);
  const manifest = report.manifest;
  const id = pluginIdOf(opts.source ?? sourceOfUrl(url), manifest.name);
  const htmlRes = await fetch(new URL(manifest.main, base), { cache: "no-cache" });
  if (!htmlRes.ok) throw new PluginLoadError(`Couldn't load ${manifest.main} (HTTP ${htmlRes.status})`);
  const html = await htmlRes.text();
  const hash = await sha256Hex(new TextEncoder().encode(html).buffer as ArrayBuffer);
  if (opts.expectedHash && hash !== opts.expectedHash) throw new PluginLoadError("This plugin changed since the presenter loaded it");
  return { id, key: opts.key ?? url, manifest, url, baseUrl: base.href, html, hash };
}

// --- GitHub ---

/** What the prompt shows about a repo. */
export interface RepoInfo {
  owner: string;
  repo: string;
  htmlUrl: string;
  description: string | null;
  stars: number;
  /** ISO time of the last push. */
  pushedAt: string | null;
  avatarUrl: string | null;
  topics: string[];
  defaultBranch: string;
}

interface RepoData {
  /** When it was fetched (ms). */
  at: number;
  info: RepoInfo;
  /** Its tags with the commits they point at, newest first as GitHub lists them. */
  tags: { name: string; sha: string }[];
}

/** localStorage: one repo's details and tags, for CACHE_MS. */
const repoCacheKey = (owner: string, repo: string) => `presio_plugin_gh_${owner.toLowerCase()}/${repo.toLowerCase()}`;
const CACHE_MS = 24 * 60 * 60 * 1000;
const JSDELIVR_GH = "https://cdn.jsdelivr.net/gh/";

async function gitHubApi<T>(path: string): Promise<T | null> {
  let res: Response;
  try {
    res = await fetch(`https://api.github.com/repos/${path}`, { headers: { Accept: "application/vnd.github+json" } });
  } catch {
    throw new Error("Couldn't reach GitHub to look the plugin up");
  }
  if (res.status === 404 || res.status === 422) return null;
  if (!res.ok) {
    throw new Error(
      res.status === 403 || res.status === 429
        ? "GitHub's rate limit for this network was hit (60 lookups an hour); try again later"
        : `Couldn't look the plugin up on GitHub (HTTP ${res.status})`
    );
  }
  return (await res.json()) as T;
}

/** A repo's details and tags: cached for a day, or fresh. A stale copy
 *  stands in when GitHub can't be asked (offline, rate limited). */
async function repoData(owner: string, repo: string, fresh = false): Promise<RepoData> {
  const key = repoCacheKey(owner, repo);
  const cached = lsGet<RepoData | null>(key, null);
  if (cached && !fresh && Date.now() - cached.at < CACHE_MS) return cached;
  const slug = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  try {
    const [info, tags] = await Promise.all([
      gitHubApi<{
        name: string;
        owner: { login: string; avatar_url?: string };
        html_url: string;
        description: string | null;
        stargazers_count: number;
        pushed_at: string | null;
        topics?: string[];
        default_branch: string;
      }>(slug),
      gitHubApi<{ name: string; commit: { sha: string } }[]>(`${slug}/tags?per_page=100`),
    ]);
    if (!info) throw new Error(`No public GitHub repo ${owner}/${repo}`);
    const data: RepoData = {
      at: Date.now(),
      info: {
        owner: info.owner.login,
        repo: info.name,
        htmlUrl: info.html_url,
        description: info.description,
        stars: info.stargazers_count,
        pushedAt: info.pushed_at,
        avatarUrl: info.owner.avatar_url ?? null,
        topics: info.topics ?? [],
        defaultBranch: info.default_branch,
      },
      tags: (tags ?? []).map((t) => ({ name: t.name, sha: t.commit.sha })),
    };
    lsSet(key, data);
    return data;
  } catch (e) {
    if (cached && !(e instanceof Error && e.message.startsWith("No public"))) return cached;
    throw e;
  }
}

// A branch's (or short commit's) full commit, once per page load.
const commits = new Map<string, Promise<string | null>>();
function commitSha(owner: string, repo: string, ref: string): Promise<string | null> {
  const key = `${owner}/${repo}@${ref}`.toLowerCase();
  let sha = commits.get(key);
  if (!sha) {
    sha = gitHubApi<{ sha: string }>(`${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`).then(
      (c) => c?.sha ?? null
    );
    sha.catch(() => commits.delete(key));
    commits.set(key, sha);
  }
  return sha;
}

// --- Resolving ---

/** Which version of a plugin this is, as people read it. */
export type PluginVersion =
  | { kind: "builtin" }
  /** A release, or another tag: pinned to the commit it points at. */
  | { kind: "tag"; tag: string; sha: string }
  /** Dev mode: a branch's newest commit, looked up again on every load. */
  | { kind: "branch"; branch: string; sha: string }
  | { kind: "commit"; sha: string }
  /** Any other URL: whatever it serves. */
  | { kind: "unpinned" };

/** "v1.2.0", "main@abc1234", "abc1234", "unpinned". */
export function formatPluginVersion(version: PluginVersion): string {
  switch (version.kind) {
    case "builtin":
      return "built in";
    case "tag":
      return version.tag;
    case "branch":
      return `${version.branch}@${shortSha(version.sha)}`;
    case "commit":
      return shortSha(version.sha);
    case "unpinned":
      return "unpinned";
  }
}

/** A plugin's source looked up: always the source and key; the rest as far as it got. */
export interface ResolvedPlugin {
  /** Its source without the version: the key it's installed and trusted under. */
  key: string;
  /** As given (with its "@" spec). */
  source: PluginSource;
  /** What an installed copy stays on, the "@" part of its source from now on:
   *  the tag, branch or commit. Undefined for built-ins and URLs. */
  ref?: string;
  version: PluginVersion | null;
  /** Where it loads from. */
  url: string | null;
  plugin: LoadedPlugin | null;
  /** Null for anything not on GitHub. */
  repo: RepoInfo | null;
  /** Worth knowing, not stopping for (a tag that doesn't match the manifest). */
  warnings: string[];
  /** Why it can't run, with each problem as its own line. */
  error: { message: string; details: string[] } | null;
}

const errorOf = (e: unknown) => ({
  message: e instanceof PluginLoadError ? e.summary : e instanceof Error ? e.message : String(e),
  details: e instanceof PluginLoadError ? e.details : [],
});

/**
 * Look a source up and load the plugin it names. Never throws: what went
 * wrong is in `error`, alongside whatever was found before it (so a plugin
 * whose manifest is broken still shows its repo). `fresh` skips the cache of
 * the repo's tags (an explicit update check).
 */
export async function resolveSource(source: PluginSource, opts: { fresh?: boolean } = {}): Promise<ResolvedPlugin> {
  const key = sourceKey(source);
  const out: ResolvedPlugin = { key, source, version: null, url: null, plugin: null, repo: null, warnings: [], error: null };
  try {
    if (source.kind === "builtin") {
      if (!(source.name in BUILTINS)) throw new Error(`No built-in plugin "${key}"`);
      out.version = { kind: "builtin" };
      out.url = builtinUrl(source.name);
      out.plugin = await loadPlugin(out.url, { source, key });
      return out;
    }
    if (source.kind === "url") {
      checkUrlPolicy(source.url);
      out.version = { kind: "unpinned" };
      out.url = source.url;
      out.plugin = await loadPlugin(out.url, { source, key });
      return out;
    }

    const { owner, repo, path } = source;
    const data = await repoData(owner, repo, opts.fresh);
    out.repo = data.info;
    const spec = parseRefSpec(source.ref);
    const tagNames = data.tags.map((t) => t.name);
    const tag = pickTag(tagNames, spec);
    if (tag) {
      out.version = { kind: "tag", tag, sha: data.tags.find((t) => t.name === tag)!.sha };
    } else if (spec.kind === "range") {
      const releases = tagNames.filter(isReleaseTag);
      throw new Error(
        `No release of ${owner}/${repo} matches ${spec.range}` + (releases.length ? ` (it has ${releases.slice(0, 5).join(", ")})` : " (it has no version tags yet)")
      );
    } else {
      // No release yet ("latest"), or a branch or commit by name.
      const ref = spec.kind === "ref" ? spec.ref : data.info.defaultBranch;
      const sha = await commitSha(owner, repo, ref);
      if (!sha) throw new Error(`${owner}/${repo} has no tag, branch or commit "${ref}"`);
      const isCommit = /^[0-9a-f]{7,40}$/i.test(ref) && sha.toLowerCase().startsWith(ref.toLowerCase());
      out.version = isCommit ? { kind: "commit", sha } : { kind: "branch", branch: ref, sha };
    }
    const v = out.version;
    out.ref = v.kind === "tag" ? v.tag : v.kind === "branch" ? v.branch : v.kind === "commit" ? v.sha : undefined;
    out.url = `${JSDELIVR_GH}${owner}/${repo}@${v.sha}/${path ? `${path}/` : ""}`;
    try {
      out.plugin = await loadPlugin(out.url, { source, key });
    } catch (e) {
      if (!(e instanceof PluginLoadError) || e.details.length) throw e;
      const where = path ? `${path}/` : "the repo's root";
      throw new PluginLoadError(`${e.message}. Is presio-plugin.json at ${where} in ${formatPluginVersion(v)}?`);
    }
    if (v.kind === "tag" && isReleaseTag(v.tag) && v.tag.replace(/^v/, "") !== out.plugin.manifest.version) {
      out.warnings.push(`It's tagged ${v.tag}, but its presio-plugin.json says version ${out.plugin.manifest.version}.`);
    }
  } catch (e) {
    out.error = errorOf(e);
  }
  return out;
}

/** A plugin with everything it needs, looked up for one prompt. */
export interface Resolution {
  /** What was asked for. */
  input: string;
  /** Null only when the input isn't a plugin source at all. */
  root: ResolvedPlugin | null;
  /** Its dependencies and theirs, each once, in the order they load
   *  (a plugin after what it needs). */
  dependencies: ResolvedPlugin[];
  /** Why it can't run, if it can't: its own error, or a dependency's. */
  error: string | null;
}

/** Everything a resolution would run: dependencies first, then the plugin. */
export const resolvedChain = (r: Resolution): ResolvedPlugin[] => (r.root ? [...r.dependencies, r.root] : []);

/**
 * Resolve a source and, recursively, its dependencies (each at the newest
 * version in the range it's asked for). A plugin appears once however many
 * ask for it, and a cycle stops where it closes.
 */
export async function resolveWithDependencies(input: string | PluginSource, opts: { fresh?: boolean } = {}): Promise<Resolution> {
  const text = typeof input === "string" ? input : formatSource(input);
  let source: PluginSource;
  try {
    source = typeof input === "string" ? parseSource(input) : input;
  } catch (e) {
    return { input: text, root: null, dependencies: [], error: e instanceof Error ? e.message : String(e) };
  }
  const seen = new Set<string>();
  const dependencies: ResolvedPlugin[] = [];
  let error: string | null = null;

  const visit = async (resolved: ResolvedPlugin, chain: string) => {
    for (const [spec, range] of Object.entries(resolved.plugin?.manifest.dependencies ?? {})) {
      let dep: PluginSource;
      try {
        dep = parseSource(spec);
      } catch (e) {
        error ??= `${chain} needs ${spec}, which isn't a plugin source: ${e instanceof Error ? e.message : e}`;
        continue;
      }
      if (dep.kind === "github") dep = { ...dep, ref: range };
      const key = sourceKey(dep);
      if (seen.has(key)) continue;
      seen.add(key);
      const r = await resolveSource(dep, opts);
      const name = r.plugin?.manifest.displayName ?? key;
      if (r.error) error ??= `${chain} needs ${spec} ${range}, which couldn't be loaded: ${r.error.message}`;
      await visit(r, name);
      dependencies.push(r);
    }
  };

  const root = await resolveSource(source, opts);
  seen.add(root.key);
  if (root.error) error = root.error.message;
  else await visit(root, root.plugin?.manifest.displayName ?? root.key);
  return { input: text, root, dependencies, error };
}

/** The newest tags of an installed plugin's repo (for update checks), from
 *  the day's cache. */
export async function repoTags(owner: string, repo: string): Promise<string[]> {
  return (await repoData(owner, repo)).tags.map((t) => t.name);
}
