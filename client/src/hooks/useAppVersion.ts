import { useState, useEffect } from "react";

// The build the server is running, as reported by /healthz (server/version.ts).
// Module-scoped because the answer cannot change without a reload: the first
// settings sheet that asks pays for the request, every later one reads this.
// `undefined` means "not asked yet", `null` means "asked, nothing to show".
let cached: string | null | undefined;

/**
 * The deployment's version string, or null when there is nothing worth showing.
 *
 * Every unhappy path collapses to null on purpose — this is a footnote, not a
 * feature, and a presenter can't act on any of them: an offline or fully local
 * deck has no server to ask, a build made outside the release workflow reports
 * "dev", and under `npm run dev` /healthz isn't proxied so the SPA's own
 * index.html comes back and fails to parse.
 *
 * `enabled` keeps the request lazy: it fires when something actually renders
 * the version, not on every controller mount.
 */
export function useAppVersion(enabled: boolean): string | null {
  const [version, setVersion] = useState<string | null>(cached ?? null);

  useEffect(() => {
    if (!enabled || cached !== undefined) return;
    let cancelled = false;
    (async () => {
      let resolved: string | null = null;
      try {
        const res = await fetch("/healthz", { cache: "no-store" });
        if (res.ok) {
          const body = (await res.json()) as { version?: unknown };
          if (typeof body.version === "string" && body.version !== "dev") {
            resolved = body.version;
          }
        }
      } catch {
        // No server, no network, or something that isn't JSON — show nothing.
      }
      cached = resolved;
      if (!cancelled) setVersion(resolved);
    })();
    return () => { cancelled = true; };
  }, [enabled]);

  return version;
}
