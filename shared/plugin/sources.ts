// Where a plugin comes from, and the id it gets from that.
//
// A plugin's id is never its own to pick: it's derived from its source, so two
// plugins can't claim the same one, and the id says whose it is. Everything
// keyed per plugin — settings, keybindings, presio.storage, retained
// messages, histories — is keyed by it.
//
//   source                                  id
//   presio/timer           (built in)       presio/timer
//   alice/poll             (shorthand)      alice/poll      = github:alice/presio-poll
//   github:alice/presio-poll[@v1.2.0]       alice/poll
//   github:alice/slides-kit[@ref]           alice/slides-kit
//   github:alice/kit@v1/plugins/poll        alice/poll      (a plugin in a folder: the folder's name)
//   https://github.com/alice/presio-poll    alice/poll      (and raw. / jsDelivr links to a repo)
//   http://localhost:5174/                  url:localhost:5174/<manifest name>
//
// Id grammar: "<scope>/<name>". The name is a slug, [a-z0-9-]. The scope is a
// GitHub owner, lowercased ("presio" is reserved for built-ins), or for a
// plugin served from any other URL, "url:" and its host (with the port). A
// GitHub repo's name loses its "presio-" prefix and is slugged: lowercased,
// with anything but letters, digits and dashes turned into dashes.
//
// Ids are used as they are in storage keys: settings and keybindings are
// "<id>.<name>" (a setting or command name has no dots, so the last dot
// splits them — see qualify/splitQualified); everything else keys JSON
// objects or joins with "\u0000". Nothing here fetches: resolving a ref to a
// commit is the client's (lib/plugins/registry.ts).

export type PluginSource =
  /** Shipped with Presio, served at /plugins/<name>/ on its own origin. */
  | { kind: "builtin"; name: string }
  /** A GitHub repo, served by jsDelivr. */
  | {
      kind: "github";
      owner: string;
      repo: string;
      /** Tag, branch or commit; undefined for "the latest". */
      ref?: string;
      /** The plugin's folder in the repo, without slashes at either end ("" for the root). */
      path: string;
    }
  /** Anywhere else: the folder its presio-plugin.json sits in, ending in "/". */
  | { kind: "url"; url: string };

/** The scope of built-in plugins' ids, which no GitHub owner may take. */
export const BUILTIN_SCOPE = "presio";
/** Repos are named "presio-<name>" by convention; the id drops the prefix. */
export const REPO_PREFIX = "presio-";

const NAME = "[a-z0-9][a-z0-9-]{0,63}";
const OWNER = "[a-z0-9][a-z0-9-]{0,38}";
const HOST = "[a-z0-9.-]{1,253}(?::\\d{1,5})?";

/** A plugin id, as derived here. The server checks ids against it too. */
export const PLUGIN_ID_RE = new RegExp(`^(?:${OWNER}|url:${HOST})/${NAME}$`);
/** A manifest's "name", the id's name part where the source doesn't give one. */
export const PLUGIN_NAME_RE = new RegExp(`^${NAME}$`);

// What GitHub allows in owner and repo names (case-insensitive). Owners
// never have dots, which keeps "example.com/x" from reading as a shorthand.
const GH_OWNER = "[A-Za-z0-9-]+";
const GH = "[A-Za-z0-9_.-]+";

/**
 * Parse what a presenter (or a link) gives as a plugin's source. Throws an
 * Error saying what's wrong. URLs are checked for shape only (http or https);
 * which hosts the app will load from is its own policy.
 */
export function parseSource(input: string): PluginSource {
  const text = input.trim();
  if (!text) throw new Error("No plugin source given");

  // owner/name[@ref]: the shorthand, a repo named presio-<name> — or a built-in.
  const short = new RegExp(`^(${GH_OWNER})/(${GH})(?:@([^/\\s]+))?$`).exec(text);
  if (short && !text.includes(":")) {
    const [, owner, name, ref] = short;
    if (owner.toLowerCase() === BUILTIN_SCOPE) {
      if (ref) throw new Error("Built-in plugins have no versions to pick");
      if (!PLUGIN_NAME_RE.test(name)) throw new Error(`No built-in plugin "${name}"`);
      return { kind: "builtin", name };
    }
    return { kind: "github", owner, repo: REPO_PREFIX + name, ref, path: "" };
  }

  const gh = parseGitHubSource(text);
  if (gh) return gh;

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(
      `"${text}" isn't a plugin source: use owner/name (a presio-<name> repo on GitHub), github:owner/repo[@tag][/folder], or a full URL`
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Plugin URLs must be http or https");
  return { kind: "url", url: normalizeBaseUrl(url) };
}

/** The folder a plugin URL points at: no query or hash, no trailing
 *  presio-plugin.json, ending in "/". */
export function normalizeBaseUrl(input: URL | string): string {
  const url = new URL(input);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/presio-plugin\.json$/, "");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.href;
}

/**
 * A GitHub location, or null when the input isn't one:
 * "github:owner/repo[@ref][/path]", a github.com repo or tree/blob link, a
 * raw.githubusercontent.com link or a cdn.jsdelivr.net/gh/ one.
 */
export function parseGitHubSource(input: string): Extract<PluginSource, { kind: "github" }> | null {
  const text = input.trim();
  const clean = (path: string | undefined) =>
    (path ?? "").replace(/(^|\/)presio-plugin\.json$/, "").replace(/^\/+|\/+$/g, "");
  const shorthand = new RegExp(`^github:(${GH})/(${GH})(?:@([^/]+))?(?:/(.*))?$`, "i").exec(text);
  if (shorthand) {
    return { kind: "github", owner: shorthand[1], repo: shorthand[2].replace(/\.git$/, ""), ref: shorthand[3], path: clean(shorthand[4]) };
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (url.hostname === "github.com" && parts.length >= 2) {
    const [owner, repo, kind, ref, ...rest] = parts;
    const tree = kind === "tree" || kind === "blob";
    return { kind: "github", owner, repo: repo.replace(/\.git$/, ""), ref: tree ? ref : undefined, path: tree ? clean(rest.join("/")) : "" };
  }
  if (url.hostname === "raw.githubusercontent.com" && parts.length >= 3) {
    // .../owner/repo/<ref>/path, where the ref may be spelled refs/heads/<ref>.
    const [owner, repo, ...rest] = parts;
    if (rest[0] === "refs" && (rest[1] === "heads" || rest[1] === "tags")) rest.splice(0, 2);
    const [ref, ...path] = rest;
    return { kind: "github", owner, repo, ref, path: clean(path.join("/")) };
  }
  if (url.hostname === "cdn.jsdelivr.net" && parts[0] === "gh" && parts.length >= 3) {
    const [, owner, repoRef, ...path] = parts;
    const [repo, ref] = repoRef.split("@");
    return { kind: "github", owner, repo, ref: ref || undefined, path: clean(path.join("/")) };
  }
  return null;
}

/** A source written back out, canonically: what the "plugins" setting keys by. */
export function formatSource(source: PluginSource): string {
  switch (source.kind) {
    case "builtin":
      return `${BUILTIN_SCOPE}/${source.name}`;
    case "github":
      return `github:${source.owner}/${source.repo}${source.ref ? `@${source.ref}` : ""}${source.path ? `/${source.path}` : ""}`;
    case "url":
      return source.url;
  }
}

/** Lowercased, with anything but letters, digits and dashes as dashes. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * The id a source gives a plugin. GitHub and built-in sources say it
 * themselves; a URL's names only its host, so its name part is the
 * manifest's `name` — pass it, or this throws.
 */
export function pluginIdOf(source: PluginSource, manifestName?: string): string {
  let id: string;
  switch (source.kind) {
    case "builtin":
      id = `${BUILTIN_SCOPE}/${source.name}`;
      break;
    case "github": {
      const owner = source.owner.toLowerCase();
      if (owner === BUILTIN_SCOPE) throw new Error(`The "${BUILTIN_SCOPE}/" ids are reserved for Presio's built-in plugins`);
      const folder = source.path ? source.path.split("/").pop()! : source.repo;
      const bare = folder.toLowerCase().startsWith(REPO_PREFIX) ? folder.slice(REPO_PREFIX.length) : folder;
      id = `${owner}/${slug(bare)}`;
      break;
    }
    case "url": {
      if (!manifestName) throw new Error("A plugin loaded from a URL takes its id's name from its manifest");
      id = `url:${new URL(source.url).host.toLowerCase()}/${manifestName}`;
      break;
    }
  }
  if (!PLUGIN_ID_RE.test(id)) throw new Error(`Can't make a plugin id from ${formatSource(source)} (got "${id}")`);
  return id;
}

/** Whether a source gives the id on its own (without the manifest). */
export function idNeedsManifest(source: PluginSource): boolean {
  return source.kind === "url";
}

/** "<id>.<name>": a plugin's setting or command, fully qualified. */
export function qualify(pluginId: string, name: string): string {
  return `${pluginId}.${name}`;
}

/** The plugin id and name in "<id>.<name>", or null when it isn't one. */
export function splitQualified(full: string): { pluginId: string; name: string } | null {
  const dot = full.lastIndexOf(".");
  if (dot < 0) return null;
  const pluginId = full.slice(0, dot);
  const name = full.slice(dot + 1);
  return PLUGIN_ID_RE.test(pluginId) && name ? { pluginId, name } : null;
}
