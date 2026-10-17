// Which version of a plugin to run, picked from its repo's tags.
//
// A plugin on GitHub is released under semver tags, "vX.Y.Z". What a source
// asks for after its "@" is one of:
//
//   nothing            the newest release tag (or, with none, the default branch)
//   v1.2.0 / 1.2.0     that version exactly
//   ^1.0.0, 1.x, …     the newest tag in the range (semver.ts)
//   main, a1b2c3d      a branch (dev mode: its newest commit, on every load)
//                      or a commit
//
// Nothing here fetches: the client looks the tags up (lib/plugins/resolve.ts).

import { compareVersions, maxSatisfying, parseRange, parseVersion, satisfies } from "./semver.js";

export type RefSpec =
  | { kind: "latest" }
  /** A version range; an exact version is a range of one. */
  | { kind: "range"; range: string }
  /** A branch, a commit or a tag that isn't a version. */
  | { kind: "ref"; ref: string };

/** What a source's "@<ref>" asks for. */
export function parseRefSpec(ref: string | undefined): RefSpec {
  if (!ref) return { kind: "latest" };
  // A bare number ("1") reads as a range, but could be a branch: only ranges
  // with an operator, a wildcard or all three parts count.
  if (parseVersion(ref) || (/[\^~*x>=]/.test(ref) && parseRange(ref))) return { kind: "range", range: ref };
  return { kind: "ref", ref };
}

/** Whether a tag is a release version ("v1.2.0", not a prerelease). */
export function isReleaseTag(tag: string): boolean {
  const v = parseVersion(tag);
  return !!v && !v.prerelease;
}

/**
 * The tag to run for a spec, or null when none fits ("latest" with no
 * release tags falls back to the default branch; that's the caller's).
 * An exact version prefers the tag spelled the way it was asked for.
 */
export function pickTag(tags: readonly string[], spec: RefSpec): string | null {
  if (spec.kind === "ref") return tags.includes(spec.ref) ? spec.ref : null;
  if (spec.kind === "latest") return maxSatisfying(tags, "*");
  if (tags.includes(spec.range)) return spec.range;
  return maxSatisfying(tags, spec.range);
}

/** Whether going from one version to another is a breaking change: outside
 *  the caret range of the first (a new major, or a new minor below 1.0.0). */
export function isBreaking(from: string, to: string): boolean {
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (!a || !b) return from !== to;
  return compareVersions(b, a) > 0 && !satisfies(b, `^${from.replace(/^v/, "")}`);
}

/** The newest tag that's a compatible update of `current` (same major), or null. */
export function compatibleUpdate(tags: readonly string[], current: string): string | null {
  const now = parseVersion(current);
  if (!now) return null;
  const best = maxSatisfying(tags, `^${current.replace(/^v/, "")}`);
  return best && compareVersions(parseVersion(best)!, now) > 0 ? best : null;
}

/** The newest release beyond `current`'s major (a breaking update), or null. */
export function breakingUpdate(tags: readonly string[], current: string): string | null {
  const best = maxSatisfying(tags, "*");
  return best && isBreaking(current, best) ? best : null;
}

/** A commit as people read it: its first 7 characters. */
export const shortSha = (sha: string) => sha.slice(0, 7);
