import type express from "express";
import { pluginIdOf } from "../../shared/plugin/sources.js";

// GET /api/plugins — plugins people can find and add: the public GitHub repos
// tagged with the `presio-plugin` topic (the build guide has every plugin's
// repo add it), most starred first.
//
// The client could ask GitHub itself, as it does to resolve a plugin, but
// search is limited to 10 requests a minute per address without a token, and
// every Add-plugin page would spend one. Asking from here once per CACHE_MS
// serves everyone from one answer. GITHUB_TOKEN, when set, lifts the limit.
// This only lists repos: what a plugin is and may do is still read from its
// manifest by the client, and it still goes through the trust prompt.

export const PLUGIN_TOPIC = "presio-plugin";
const CACHE_MS = 5 * 60 * 1000;
/** After a failed search, how long to serve what we have before asking again. */
const RETRY_MS = 60 * 1000;
const PER_PAGE = 100;

export interface DiscoveredPlugin {
  /** What to add it by: "github:<owner>/<repo>". */
  source: string;
  /** The id it will get ("alice/poll"). */
  id: string;
  owner: string;
  repo: string;
  description: string | null;
  stars: number;
  /** ISO time of the last push. */
  pushedAt: string | null;
  htmlUrl: string;
  avatarUrl: string | null;
  topics: string[];
}

interface SearchItem {
  name: string;
  owner: { login: string; avatar_url?: string };
  html_url: string;
  description: string | null;
  stargazers_count: number;
  pushed_at: string | null;
  topics?: string[];
  archived?: boolean;
}

type Fetch = typeof fetch;

/** The topic's repos, as GitHub's search returns them. */
async function searchGitHub(fetchImpl: Fetch): Promise<DiscoveredPlugin[]> {
  const q = encodeURIComponent(`topic:${PLUGIN_TOPIC} archived:false is:public`);
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "presio",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetchImpl(`https://api.github.com/search/repositories?q=${q}&sort=stars&order=desc&per_page=${PER_PAGE}`, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub search failed (HTTP ${res.status})`);
  const body = (await res.json()) as { items?: SearchItem[] };
  const plugins: DiscoveredPlugin[] = [];
  for (const item of body.items ?? []) {
    const source = { kind: "github" as const, owner: item.owner.login, repo: item.name, path: "" };
    let id: string;
    try {
      id = pluginIdOf(source);
    } catch {
      // A name no id can be made from (or a "presio" owner): it can't be added.
      continue;
    }
    plugins.push({
      source: `github:${item.owner.login}/${item.name}`,
      id,
      owner: item.owner.login,
      repo: item.name,
      description: item.description,
      stars: item.stargazers_count,
      pushedAt: item.pushed_at,
      htmlUrl: item.html_url,
      avatarUrl: item.owner.avatar_url ?? null,
      topics: item.topics ?? [],
    });
  }
  return plugins;
}

/** The list, cached for CACHE_MS. One search runs at a time; a stale list
 *  stands in while GitHub can't be asked. */
export function pluginDirectory(fetchImpl: Fetch = fetch) {
  let cached: { at: number; plugins: DiscoveredPlugin[] } | null = null;
  let nextTry = 0;
  let inFlight: Promise<void> | null = null;

  const refresh = () =>
    (inFlight ??= searchGitHub(fetchImpl)
      .then((plugins) => {
        cached = { at: Date.now(), plugins };
      })
      .catch((err: Error) => {
        nextTry = Date.now() + RETRY_MS;
        if (!cached) throw err;
        console.warn(`[plugins] ${err.message}; serving the list from ${new Date(cached.at).toISOString()}`);
      })
      .finally(() => {
        inFlight = null;
      }));

  return async function list(): Promise<{ plugins: DiscoveredPlugin[]; fetchedAt: string }> {
    const now = Date.now();
    if ((!cached || now - cached.at >= CACHE_MS) && now >= nextTry) await refresh();
    else if (!cached) throw new Error("GitHub search is unavailable; try again shortly");
    return { plugins: cached!.plugins, fetchedAt: new Date(cached!.at).toISOString() };
  };
}

export function registerPluginRoutes(app: express.Express, { fetchImpl }: { fetchImpl?: Fetch } = {}) {
  const list = pluginDirectory(fetchImpl);
  app.get("/api/plugins", async (_req, res) => {
    try {
      const result = await list();
      res.set("Cache-Control", `public, max-age=${CACHE_MS / 1000}`);
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });
}
