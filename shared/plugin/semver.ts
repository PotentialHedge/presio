// Just enough semver for plugin versions: a plugin's git tags are "vX.Y.Z"
// (equal to its manifest's "version"), and dependencies name ranges of them.
// No dependency on the npm package, so the checker script stays one file.
//
// Ranges: exact ("1.2.3", "v1.2.3"), caret ("^1.2.3": same major — or, below
// 1.0.0, same minor), tilde ("~1.2.3": same minor), wildcards ("1.x", "1.2.x",
// "*"), and ">=1.2.3". A prerelease ("1.2.3-beta.1") only matches a range
// that names it exactly: asking for "^1.2.0" never gets you a beta.

export interface Version {
  major: number;
  minor: number;
  patch: number;
  /** "beta.1" in 1.2.3-beta.1; "" for a release. */
  prerelease: string;
}

const VERSION_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

/** A version string ("1.2.3" or a tag, "v1.2.3"), or null when it isn't one. */
export function parseVersion(text: string): Version | null {
  const m = VERSION_RE.exec(text.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), prerelease: m[4] ?? "" };
}

export function formatVersion(v: Version): string {
  return `${v.major}.${v.minor}.${v.patch}${v.prerelease ? `-${v.prerelease}` : ""}`;
}

/** Negative when a < b, 0 when equal, positive when a > b. */
export function compareVersions(a: Version, b: Version): number {
  const d = a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (d) return d;
  // A release sorts after its prereleases; prereleases compare part by part.
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  const pa = a.prerelease.split(".");
  const pb = b.prerelease.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if (pa[i] === undefined) return -1;
    if (pb[i] === undefined) return 1;
    const na = /^\d+$/.test(pa[i]) ? Number(pa[i]) : NaN;
    const nb = /^\d+$/.test(pb[i]) ? Number(pb[i]) : NaN;
    if (!Number.isNaN(na) && !Number.isNaN(nb)) {
      if (na !== nb) return na - nb;
    } else if (pa[i] !== pb[i]) {
      return pa[i] < pb[i] ? -1 : 1;
    }
  }
  return 0;
}

/** A parsed range: the versions from `min` (inclusive) up to `max` (exclusive). */
export interface Range {
  min: Version;
  /** null: no upper bound (">=", "*"). */
  max: Version | null;
  /** An exact range, the only kind a prerelease can satisfy. */
  exact: boolean;
}

const v = (major: number, minor: number, patch: number): Version => ({ major, minor, patch, prerelease: "" });

/** A range string, or null when it isn't one this understands. */
export function parseRange(text: string): Range | null {
  const t = text.trim();
  if (t === "*" || t === "x" || t === "") return { min: v(0, 0, 0), max: null, exact: false };

  const wildcard = /^v?(0|[1-9]\d*)(?:\.(0|[1-9]\d*|x|\*))?(?:\.(x|\*))?$/.exec(t);
  if (wildcard && (wildcard[2] === undefined || wildcard[2] === "x" || wildcard[2] === "*" || wildcard[3] !== undefined)) {
    const major = Number(wildcard[1]);
    const minor = wildcard[2] === undefined || wildcard[2] === "x" || wildcard[2] === "*" ? null : Number(wildcard[2]);
    return minor === null
      ? { min: v(major, 0, 0), max: v(major + 1, 0, 0), exact: false }
      : { min: v(major, minor, 0), max: v(major, minor + 1, 0), exact: false };
  }

  const op = /^(\^|~|>=)?\s*(.+)$/.exec(t);
  // "^1" and "~1.2" mean "^1.0.0" and "~1.2.0".
  const partial = op && /^v?\d+(\.\d+)?$/.test(op[2]) && op[1] ? `${op[2]}${op[2].includes(".") ? ".0" : ".0.0"}` : op?.[2];
  const base = op && partial !== undefined ? parseVersion(partial) : null;
  if (!op || !base) return null;
  const { major, minor, patch } = base;
  switch (op[1]) {
    case "^":
      // Below 1.0.0 the leftmost non-zero part is the breaking one.
      if (major > 0) return { min: base, max: v(major + 1, 0, 0), exact: false };
      if (minor > 0) return { min: base, max: v(0, minor + 1, 0), exact: false };
      return { min: base, max: v(0, 0, patch + 1), exact: false };
    case "~":
      return { min: base, max: v(major, minor + 1, 0), exact: false };
    case ">=":
      return { min: base, max: null, exact: false };
    default:
      return { min: base, max: base, exact: true };
  }
}

/** Whether a version is in a range (both as strings or parsed). */
export function satisfies(version: Version | string, range: Range | string): boolean {
  const ver = typeof version === "string" ? parseVersion(version) : version;
  const r = typeof range === "string" ? parseRange(range) : range;
  if (!ver || !r) return false;
  if (r.exact) return compareVersions(ver, r.min) === 0;
  if (ver.prerelease) return false;
  if (compareVersions(ver, r.min) < 0) return false;
  return r.max === null || compareVersions(ver, r.max) < 0;
}

/** The newest of these versions (or tags) in the range, as given; null if none. */
export function maxSatisfying(versions: readonly string[], range: Range | string): string | null {
  let best: { text: string; version: Version } | null = null;
  for (const text of versions) {
    const version = parseVersion(text);
    if (!version || !satisfies(version, range)) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { text, version };
  }
  return best?.text ?? null;
}
