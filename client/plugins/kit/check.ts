// The plugin checker, served as /plugins/check.mjs: one file, no
// dependencies, for Node 18+. A plugin's author (usually an agent) runs it in
// the plugin's folder before tagging a release:
//
//   node check.mjs [folder] [--presio https://presio.ch] [--json]
//
// It runs the same manifest validator as Presio itself (shared/plugin), then
// checks what only the author's machine can see: the files the manifest
// names, the git tag against the version, and the repo's name. Every problem
// says how to fix it. Exit code 1 when there are errors.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { validateManifest, type PluginManifest } from "../../../shared/plugin/manifest.ts";
import { API_VERSION } from "../../../shared/plugin/protocol.ts";
import { REPO_PREFIX } from "../../../shared/plugin/sources.ts";

interface Report {
  folder: string;
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** What the plugin is, when the manifest is valid. */
  plugin: { id: string | null; name: string; version: string; surfaces: string[]; permissions: string[] } | null;
  /** The link that loads this release in Presio, when it's tagged on GitHub. */
  link: string | null;
  /** What to do next. */
  next: string[];
}

const MANIFEST = "presio-plugin.json";

function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const presioAt = args.indexOf("--presio");
  const presio = (presioAt >= 0 ? args[presioAt + 1] : undefined)?.replace(/\/+$/, "") || "https://presio.ch";
  const folder = path.resolve(args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--presio") ?? ".");
  const report = check(folder, presio);
  if (json) console.log(JSON.stringify(report, null, 2));
  else print(report);
  process.exitCode = report.ok ? 0 : 1;
}

function check(folder: string, presio: string): Report {
  const report: Report = { folder, ok: false, errors: [], warnings: [], plugin: null, link: null, next: [] };
  const error = (m: string) => report.errors.push(m);
  const warn = (m: string) => report.warnings.push(m);

  const manifestPath = path.join(folder, MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    error(`No ${MANIFEST} in ${folder}: run the checker in the plugin's folder, or pass it (node check.mjs path/to/plugin)`);
    return report;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (e) {
    error(`${MANIFEST} isn't valid JSON: ${(e as Error).message}`);
    return report;
  }

  const validated = validateManifest(raw);
  for (const e of validated.errors) error(`${MANIFEST} → ${e}`);
  for (const w of validated.warnings) warn(`${MANIFEST} → ${w}`);
  const manifest = validated.manifest;
  if (manifest) checkFiles(folder, manifest, error, warn);

  const git = gitInfo(folder);
  let id: string | null = null;
  if (!git) {
    warn("Not in a git repo: publish the plugin as a public GitHub repo named presio-<name> (see /plugins.md → Publish)");
  } else if (manifest) {
    id = checkRepo(git, manifest, error, warn);
    const tag = `v${manifest.version}`;
    const atHead = git.tagsAtHead.filter((t) => /^v\d/.test(t));
    // (With uncommitted changes, they're the next release, not this commit.)
    const other = git.dirty ? [] : atHead.filter((t) => t !== tag);
    if (other.length) {
      error(`The commit is tagged ${other.join(", ")}, but presio-plugin.json says version ${manifest.version}: the tag must be "v" + version. Set "version" to match, or tag ${tag} instead`);
    }
    if (git.dirty) {
      warn("There are uncommitted changes: commit them before tagging, since a release is a commit");
    }
    if (atHead.includes(tag) && !git.dirty) {
      if (git.github) report.link = `${presio}/?plugins=${source(git.github, tag)}`;
      if (!tagPushed(folder, tag)) report.next.push(`Push the commit and the tag: git push && git push origin ${tag}`);
    } else if (git.tags.includes(tag)) {
      error(`Tag ${tag} already exists on another commit: bump "version" in presio-plugin.json for this release (tags are never moved)`);
    } else if (!report.errors.length) {
      report.next.push(`Release it: git add -A && git commit -m "v${manifest.version}" && git tag ${tag} && git push && git push origin ${tag}`);
    }
  }

  report.ok = report.errors.length === 0;
  if (manifest) {
    report.plugin = {
      id,
      name: manifest.displayName,
      version: manifest.version,
      surfaces: manifest.surfaces,
      permissions: manifest.permissions,
    };
  }
  if (report.ok && report.link) report.next.push(`Open ${report.link} in a browser to load it (the presenter confirms a trust prompt)`);
  if (report.ok && git?.github && !report.link) {
    report.next.push(`While developing: ${presio}/?plugins=${source(git.github, git.branch ?? "main")} loads the branch's newest pushed commit`);
  }
  return report;
}

/** The files presio-plugin.json points at, and the ones main loads. */
function checkFiles(folder: string, manifest: PluginManifest, error: (m: string) => void, warn: (m: string) => void) {
  const mainPath = path.join(folder, manifest.main);
  if (!fs.existsSync(mainPath)) {
    error(`"main" is ${manifest.main}, which doesn't exist: create it, or point "main" at the plugin's HTML file`);
    return;
  }
  const html = fs.readFileSync(mainPath, "utf8");
  if (!/\bpresio\./.test(html) && !/<script[^>]+src=/i.test(html)) {
    warn(`${manifest.main} never uses presio.*: a plugin's code talks to Presio through window.presio`);
  }
  // Relative URLs main loads: they're served from the plugin's folder, so
  // they must be committed beside it.
  for (const [, url] of html.matchAll(/<(?:script|link|img)\b[^>]*?\s(?:src|href)=["']([^"']+)["']/gi)) {
    if (/^(?:[a-z]+:|\/\/|#|data:)/i.test(url)) continue;
    const file = path.join(path.dirname(mainPath), url.split(/[?#]/)[0]);
    if (url.startsWith("/")) {
      error(`${manifest.main} loads "${url}" from the site's root, which is Presio's, not the plugin's: use a relative path ("${url.slice(1)}")`);
    } else if (!fs.existsSync(file)) {
      error(`${manifest.main} loads "${url}", which doesn't exist in the plugin's folder (a plugin with a build step commits its built files)`);
    }
  }
  if (!fs.existsSync(path.join(folder, "README.md"))) warn("No README.md: say what the plugin does and how to load it (?plugins=…)");
  if (manifest.presio !== API_VERSION) warn(`Written for plugin API ${manifest.presio}; this checker knows ${API_VERSION}`);
}

interface GitInfo {
  root: string;
  /** owner/repo of the origin remote, when it's on GitHub. */
  github: { owner: string; repo: string; path: string } | null;
  branch: string | null;
  tags: string[];
  tagsAtHead: string[];
  dirty: boolean;
}

function git(cwd: string, ...args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function gitInfo(folder: string): GitInfo | null {
  const root = git(folder, "rev-parse", "--show-toplevel");
  if (!root) return null;
  const remote = git(folder, "remote", "get-url", "origin") ?? "";
  const m = /github\.com[:/]([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote);
  const sub = path.relative(fs.realpathSync(root), fs.realpathSync(folder)).split(path.sep).join("/");
  const list = (out: string | null) => (out ? out.split("\n").filter(Boolean) : []);
  const committed = !!git(folder, "rev-parse", "-q", "--verify", "HEAD");
  const branch = git(folder, "symbolic-ref", "--short", "-q", "HEAD");
  return {
    root,
    github: m ? { owner: m[1], repo: m[2], path: sub } : null,
    branch,
    tags: list(git(folder, "tag", "--list")),
    tagsAtHead: committed ? list(git(folder, "tag", "--points-at", "HEAD")) : [],
    dirty: !!git(folder, "status", "--porcelain", "--", "."),
  };
}

/** Whether the tag is on GitHub (asks the remote; false when it can't). */
function tagPushed(folder: string, tag: string): boolean {
  return !!git(folder, "ls-remote", "--tags", "origin", `refs/tags/${tag}`);
}

/** The repo's name against the convention; returns the plugin's id. */
function checkRepo(info: GitInfo, manifest: PluginManifest, error: (m: string) => void, warn: (m: string) => void): string | null {
  if (!info.github) {
    warn("The origin remote isn't on GitHub: presenters load a plugin by its GitHub repo (or a URL you host)");
    return null;
  }
  const { owner, repo, path: sub } = info.github;
  if (sub) return `${owner}/${sub.split("/").pop()}`;
  if (!repo.startsWith(REPO_PREFIX)) {
    warn(`The repo is "${repo}": name it "${REPO_PREFIX}${manifest.name}" (gh repo rename ${REPO_PREFIX}${manifest.name}), so its id is ${owner}/${manifest.name} and the shorthand ${owner}/${manifest.name} loads it`);
    return `${owner}/${repo.toLowerCase()}`;
  }
  const name = repo.slice(REPO_PREFIX.length);
  if (name !== manifest.name) {
    error(`The repo is "${repo}" but "name" is "${manifest.name}": make them match ("name": "${name}"), since the id comes from the repo`);
  }
  return `${owner}/${name}`;
}

/** What goes in ?plugins= for a tag or branch: the shorthand where the
 *  repo follows the convention. */
function source(gh: { owner: string; repo: string; path: string }, ref: string): string {
  if (!gh.path && gh.repo.startsWith(REPO_PREFIX)) return `${gh.owner}/${gh.repo.slice(REPO_PREFIX.length)}@${ref}`;
  return `github:${gh.owner}/${gh.repo}@${ref}${gh.path ? `/${gh.path}` : ""}`;
}

function print(r: Report) {
  const line = (s = "") => console.log(s);
  if (r.plugin) line(`${r.plugin.name} ${r.plugin.version}${r.plugin.id ? ` (${r.plugin.id})` : ""}`);
  for (const e of r.errors) line(`  ✗ ${e}`);
  for (const w of r.warnings) line(`  ! ${w}`);
  if (r.ok) line(r.warnings.length ? "  ✓ valid, with warnings" : "  ✓ valid");
  if (r.next.length) {
    line();
    for (const n of r.next) line(`→ ${n}`);
  }
}

main();
