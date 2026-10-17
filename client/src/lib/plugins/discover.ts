// Plugins to discover: the server's list of GitHub repos tagged
// `presio-plugin` (server/routes/plugins.ts). Adding one still goes through
// the trust prompt, which reads its manifest; this is only what to show.

import { useEffect, useState } from "react";

export interface DiscoveredPlugin {
  /** What to add it by: "github:<owner>/<repo>". */
  source: string;
  /** The id it will get ("alice/poll"). */
  id: string;
  owner: string;
  repo: string;
  description: string | null;
  stars: number;
  pushedAt: string | null;
  htmlUrl: string;
  avatarUrl: string | null;
  topics: string[];
}

export type Discovery =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; plugins: DiscoveredPlugin[] };

/** Fetched once per page load; the server caches GitHub's answer anyway. */
let pending: Promise<DiscoveredPlugin[]> | null = null;

function fetchDiscovered(): Promise<DiscoveredPlugin[]> {
  pending ??= fetch("/api/plugins")
    .then(async (res) => {
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Couldn't load the plugin list (HTTP ${res.status})`);
      return (body.plugins ?? []) as DiscoveredPlugin[];
    })
    .catch((err: Error) => {
      pending = null;
      throw err.name === "TypeError" ? new Error("Couldn't reach the server for the plugin list") : err;
    });
  return pending;
}

export function useDiscoveredPlugins(): Discovery {
  const [state, setState] = useState<Discovery>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    fetchDiscovered().then(
      (plugins) => !cancelled && setState({ status: "ready", plugins }),
      (err: Error) => !cancelled && setState({ status: "error", error: err.message })
    );
    return () => { cancelled = true; };
  }, []);
  return state;
}
