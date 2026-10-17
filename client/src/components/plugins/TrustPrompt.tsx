import { useEffect, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  CircleAlert,
  Clock,
  ExternalLink,
  GitBranch,
  GitCommitHorizontal,
  Globe,
  LoaderCircle,
  Puzzle,
  ShieldAlert,
  Star,
  Tag,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DialogOverlay } from "@/components/ui/dialog-overlay";
import { findEntry, installResolved, loadResolvedOnce, setPluginEnabled } from "@/lib/plugins/registry";
import {
  formatPluginVersion,
  resolvedChain,
  resolveWithDependencies,
  type PluginVersion,
  type Resolution,
  type ResolvedPlugin,
} from "@/lib/plugins/resolve";
import { grantTrust, needsApproval, trustChange, type TrustChange } from "@/lib/plugins/trust";
import { finishPrompt, requestPlugin, usePromptQueue, type PromptChoice, type PromptRequest } from "@/lib/plugins/prompts";
import { checkForUpdates } from "@/lib/plugins/updates";
import { AUDIENCE_SURFACES, PERMISSIONS } from "@/lib/plugins/access";
import { NewBadge, PluginAccess } from "./PluginAccess";

// The trust prompt: what a plugin is, who made it, what it may do and where
// it shows up, before it runs. One plugin at a time (with its dependencies),
// from a ?plugins= link, Settings' "Add plugin", or an update or dev commit
// that wants more than was approved. Mounted once, in App.

const TRUST_WARNING = "Only load plugins you trust: a plugin can act as you on this device.";

/** Is this the presenter's side of the app, where a ?plugins= link means something? */
function isPresenterRoute(pathname: string, params: URLSearchParams): boolean {
  if (pathname === "/" || pathname === "/present" || pathname.startsWith("/start/")) return true;
  return /^\/s\/[^/]+\/?$/.test(pathname) && params.get("role") === "controller";
}

/** ?plugins=a,b: queue a prompt for each, and take the param off the URL. */
function useLinkedPlugins() {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const raw = params.get("plugins");
    if (raw === null || !isPresenterRoute(location.pathname, params)) return;
    params.delete("plugins");
    const search = params.toString();
    navigate({ pathname: location.pathname, search: search ? `?${search}` : "", hash: location.hash }, { replace: true, state: location.state });
    for (const input of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
      // A built-in is part of Presio: nothing to ask, just switch it on.
      const builtin = /^presio\/([a-z0-9-]+)$/i.exec(input);
      if (builtin && findEntry(`presio/${builtin[1].toLowerCase()}`)) setPluginEnabled(`presio/${builtin[1].toLowerCase()}`, true);
      else requestPlugin(input, { reason: "link" });
    }
  }, [location, navigate]);
}

/** The prompts, one at a time, plus what feeds them on the presenter's side. */
export function PluginPrompts() {
  useLinkedPlugins();
  const { pathname, search } = useLocation();
  const presenter = isPresenterRoute(pathname, new URLSearchParams(search));
  useEffect(() => {
    if (presenter) void checkForUpdates();
  }, [presenter]);
  const queue = usePromptQueue();
  // Viewers run what the presenter published: they're never asked.
  if (!presenter || !queue.length) return null;
  return <TrustPrompt key={queue[0].id} request={queue[0]} remaining={queue.length - 1} />;
}

/** A plugin that's on this device already, as this resolution would have it. */
function alreadyHere(resolution: Resolution): "installed" | "session" | null {
  const entry = resolution.root && findEntry(resolution.root.key);
  if (!entry || entry.builtin) return null;
  return entry.session ? "session" : "installed";
}

function TrustPrompt({ request, remaining }: { request: PromptRequest; remaining: number }) {
  const [resolution, setResolution] = useState<Resolution | null>(request.resolution ?? null);
  const [actionError, setActionError] = useState("");

  const act = (choice: PromptChoice, r: Resolution | null = resolution) => {
    try {
      const chain = r ? resolvedChain(r) : [];
      if (choice === "install") installResolved(chain);
      if (choice === "once") loadResolvedOnce(chain);
      if (choice !== "skip") grantTrust(chain);
      finishPrompt(request.id, { choice, key: r?.root?.key, plugin: r?.root?.plugin ?? undefined });
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    if (request.resolution) return;
    let cancelled = false;
    void resolveWithDependencies(request.input).then((r) => {
      if (cancelled) return;
      // Nothing to ask: a built-in (part of Presio) is just switched on, and
      // a link to a plugin that's here and trusted updates it in place.
      if (!r.error && r.root?.source.kind === "builtin") {
        setPluginEnabled(r.root.key, true);
        finishPrompt(request.id, { choice: "install", key: r.root.key, plugin: r.root.plugin ?? undefined });
        return;
      }
      const here = request.reason === "link" && !r.error ? alreadyHere(r) : null;
      if (here && !needsApproval(r)) return act(here === "session" ? "once" : "install", r);
      setResolution(r);
    });
    return () => { cancelled = true; };
    // Once per request (keyed by it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!resolution) {
    return (
      <PromptFrame
        footer={<Button variant="ghost" onClick={() => act("skip")}>Cancel</Button>}
      >
        <div className="flex items-center gap-3 py-6 text-sm text-muted-foreground" data-testid="plugin-prompt-loading">
          <LoaderCircle className="size-5 animate-spin" />
          Looking up <span className="font-mono text-foreground">{request.input}</span>…
        </div>
      </PromptFrame>
    );
  }

  const root = resolution.root;
  const chain = resolvedChain(resolution);
  const changes = chain.map((r) => [r, trustChange(r)] as const);
  const rootChange = root ? trustChange(root) : null;
  const ok = !resolution.error && !!root?.plugin;
  // An installed plugin's new commit is allowed the way it's on: installed, or for this tab.
  const devChoice: PromptChoice = root && findEntry(root.key)?.session ? "once" : "install";

  const footer =
    request.reason === "update" ? (
      <>
        <Button variant="ghost" onClick={() => act("skip")}>Not now</Button>
        <Button disabled={!ok} onClick={() => act("install")} data-testid="plugin-prompt-install">Update</Button>
      </>
    ) : request.reason === "dev" ? (
      <>
        <Button variant="ghost" onClick={() => act("skip")}>Skip</Button>
        <Button disabled={!ok} onClick={() => act(devChoice)} data-testid="plugin-prompt-install">Allow</Button>
      </>
    ) : (
      <>
        <Button variant="ghost" onClick={() => act("skip")} data-testid="plugin-prompt-skip">Skip</Button>
        <Button variant="outline" disabled={!ok} onClick={() => act("once")} title="Run it in this tab only, until you close it" data-testid="plugin-prompt-once">
          Load once
        </Button>
        <Button disabled={!ok} onClick={() => act("install")} title="Add it to your plugins" data-testid="plugin-prompt-install">
          Install
        </Button>
      </>
    );

  const overline = {
    link: "A link wants to load a plugin",
    add: "Add a plugin",
    update: "Update available",
    dev: "A new commit wants more access",
  }[request.reason];

  return (
    <PromptFrame footer={footer} remaining={remaining}>
      <PluginHeader overline={overline} resolved={root} input={resolution.input} />

      {rootChange && !rootChange.first && <ChangeSummary change={rootChange} />}

      {resolution.error && (
        <Callout tone="error" icon={<CircleAlert className="size-4" />} testId="plugin-prompt-error">
          <p className="font-medium">This plugin can't be loaded</p>
          <p>{resolution.error}</p>
          {(root?.error?.details.length ?? 0) > 0 && (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4 font-mono text-xs">
              {root!.error!.details.map((d) => <li key={d}>{d}</li>)}
            </ul>
          )}
        </Callout>
      )}

      {root?.warnings.map((w) => (
        <p key={w} className="text-xs text-amber-700 dark:text-amber-400">{w}</p>
      ))}

      {root?.plugin && (
        <Section title="It can">
          <PluginAccess
            manifest={root.plugin.manifest}
            newPermissions={rootChange && !rootChange.first ? rootChange.permissions : []}
          />
        </Section>
      )}

      {resolution.dependencies.length > 0 && (
        <Section title={`Also loads ${resolution.dependencies.length === 1 ? "a plugin it needs" : `${resolution.dependencies.length} plugins it needs`}`}>
          <ul className="divide-y rounded-lg border">
            {changes
              .filter(([r]) => r !== root)
              .map(([r, change]) => <DependencyRow key={r.key} resolved={r} change={change} />)}
          </ul>
        </Section>
      )}

      <Callout tone="warning" icon={<ShieldAlert className="size-4" />} testId="plugin-prompt-warning">
        <p>{TRUST_WARNING}</p>
      </Callout>

      {actionError && <p className="text-sm text-destructive">{actionError}</p>}
    </PromptFrame>
  );
}

function PromptFrame({ children, footer, remaining = 0 }: { children: ReactNode; footer: ReactNode; remaining?: number }) {
  return (
    // Over everything, Settings included; a stray click outside isn't a choice.
    <DialogOverlay onClose={() => {}} maxWidth="max-w-lg" bare layer="z-[60]">
      <div role="dialog" aria-modal="true" aria-label="Load a plugin" data-testid="plugin-prompt" className="flex min-h-0 flex-col">
        <div className="min-h-0 space-y-5 overflow-y-auto px-6 pt-6 pb-5">{children}</div>
        <div className="flex items-center gap-2 border-t bg-muted/40 px-6 py-3.5">
          <span className="mr-auto text-xs text-muted-foreground">{remaining > 0 && `${remaining} more after this`}</span>
          {footer}
        </div>
      </div>
    </DialogOverlay>
  );
}

function PluginHeader({ overline, resolved, input }: { overline: string; resolved: ResolvedPlugin | null; input: string }) {
  const manifest = resolved?.plugin?.manifest;
  const repo = resolved?.repo;
  const name = manifest?.displayName ?? (repo ? repo.repo : input);
  const author = manifest?.author ?? repo?.owner;
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3.5">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <Puzzle className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{overline}</p>
          <h2 className="truncate text-lg font-semibold leading-tight" data-testid="plugin-prompt-name">{name}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {resolved?.plugin && <span className="font-mono text-xs text-muted-foreground">{resolved.plugin.id}</span>}
            {resolved?.version && <VersionBadge version={resolved.version} />}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {author && (
          <span className="flex items-center gap-1.5">
            {repo?.avatarUrl && <img src={repo.avatarUrl} alt="" className="size-4 rounded-full" />}
            by <span className="text-foreground">{author}</span>
          </span>
        )}
        {repo && (
          <span className="flex items-center gap-1" title={`${repo.stars} stars on GitHub`}>
            <Star className="size-3.5" /> {repo.stars.toLocaleString()}
          </span>
        )}
        {repo?.pushedAt && (
          <span className="flex items-center gap-1" title={new Date(repo.pushedAt).toLocaleString()}>
            <Clock className="size-3.5" /> updated {timeAgo(repo.pushedAt)}
          </span>
        )}
        {repo ? (
          <a href={repo.htmlUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-primary hover:underline">
            {repo.owner}/{repo.repo} <ExternalLink className="size-3" />
          </a>
        ) : (
          resolved?.source.kind === "url" && (
            <span className="flex items-center gap-1 font-mono">
              <Globe className="size-3.5" /> {resolved.source.url}
            </span>
          )
        )}
      </div>

      {(manifest?.description ?? repo?.description) && (
        <p className="text-sm">{manifest?.description ?? repo?.description}</p>
      )}
    </div>
  );
}

function VersionBadge({ version }: { version: PluginVersion }) {
  const base = "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[11px] leading-none";
  const amber = "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400";
  switch (version.kind) {
    case "tag":
      return <span className={`${base} text-foreground`}><Tag className="size-3" />{version.tag}</span>;
    case "branch":
      return (
        <span className={`${base} ${amber}`} title="Dev mode: the branch's newest commit, looked up again every time it loads">
          <GitBranch className="size-3" />{formatPluginVersion(version)} · dev
        </span>
      );
    case "commit":
      return <span className={`${base} text-foreground`}><GitCommitHorizontal className="size-3" />{formatPluginVersion(version)}</span>;
    case "unpinned":
      return (
        <span className={`${base} ${amber}`} title="Not pinned to a version: it runs whatever that address serves">
          unpinned
        </span>
      );
    case "builtin":
      return <span className={base}>built in</span>;
  }
}

/** What changed since the presenter last allowed this plugin. */
function ChangeSummary({ change }: { change: TrustChange }) {
  return (
    <Callout tone="info" icon={<CircleAlert className="size-4" />}>
      <p className="font-medium">Since you last allowed it</p>
      <ul className="list-disc space-y-0.5 pl-4">
        {change.major && <li>A new major version: {change.major.from} → {change.major.to}, which may work differently</li>}
        {change.permissions.map((p) => <li key={p}>It now asks to {PERMISSIONS[p].title.toLowerCase()}</li>)}
        {change.dependencies.map((d) => <li key={d}>It now also loads <span className="font-mono">{d}</span></li>)}
      </ul>
    </Callout>
  );
}

function DependencyRow({ resolved, change }: { resolved: ResolvedPlugin; change: TrustChange | null }) {
  const manifest = resolved.plugin?.manifest;
  const isNew = !!change && (change.first || change.permissions.length > 0 || !!change.major);
  return (
    <li className="space-y-1 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <span className="font-medium">{manifest?.displayName ?? resolved.key}</span>
        {resolved.version && <VersionBadge version={resolved.version} />}
        {isNew && <NewBadge />}
        {resolved.repo && (
          <a href={resolved.repo.htmlUrl} target="_blank" rel="noreferrer" className="ml-auto text-xs text-primary hover:underline">
            {resolved.repo.owner}/{resolved.repo.repo}
          </a>
        )}
      </div>
      {manifest?.description && <p className="text-xs text-muted-foreground">{manifest.description}</p>}
      {manifest && (
        <p className="text-xs text-muted-foreground">
          {manifest.permissions.length ? `Can ${manifest.permissions.map((p) => PERMISSIONS[p].title.toLowerCase()).join(", ")}` : "No extra permissions"}
          {manifest.surfaces.some((s) => AUDIENCE_SURFACES.includes(s)) && " · runs on your audience's devices"}
        </p>
      )}
      {resolved.error && (
        <p className="text-xs text-destructive">
          {resolved.error.message}
          {resolved.error.details.length > 0 && `: ${resolved.error.details.join("; ")}`}
        </p>
      )}
    </li>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

function Callout({ tone, icon, children, testId }: { tone: "warning" | "error" | "info"; icon: ReactNode; children: ReactNode; testId?: string }) {
  const tones = {
    warning: "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200",
    error: "border-destructive/40 bg-destructive/10 text-destructive",
    info: "border-primary/30 bg-primary/5 text-foreground",
  };
  return (
    <div className={`flex gap-2.5 rounded-lg border px-3 py-2.5 text-sm ${tones[tone]}`} data-testid={testId}>
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 space-y-1">{children}</div>
    </div>
  );
}

/** "3 days ago", "2 months ago". */
function timeAgo(iso: string): string {
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 365 * 86400],
    ["month", 30 * 86400],
    ["week", 7 * 86400],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  }
  return "just now";
}
