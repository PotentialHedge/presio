import { useState } from "react";
import { Check, Copy, Star, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { agentPrompt } from "@/lib/plugins/agentPrompt";
import type { PluginHost } from "@/lib/plugins/host";
import { findCommand, type LoadedPlugin, type PluginSettingSpec } from "@/lib/plugins/manifest";
import { resolvePluginSettings, setPluginSetting, useSetting, useSettingsDocument } from "@/lib/settings";
import { formatBinding, pluginBindings, shortcutTakenBy, type PluginShortcutSet } from "@/lib/keymap";
import { describeEntry, removePlugin, setPluginEnabled, usePluginEntries } from "@/lib/plugins/registry";
import { useDiscoveredPlugins, type DiscoveredPlugin } from "@/lib/plugins/discover";
import { requestPlugin } from "@/lib/plugins/prompts";
import { promptUpdate, useUpdateInfo, type UpdateInfo } from "@/lib/plugins/updates";
import { pluginLabel, type InstalledPlugin } from "@/lib/plugins/installed";
import { qualify } from "@shared/plugin/sources";
import { PluginAccess } from "./PluginAccess";
import { PluginButtons } from "./PresenterPlugins";

// Settings for plugins: one page per installed plugin (switch it on or off,
// see what it adds and may do, use its actions, edit its settings), a page to
// add one by URL and one to pick from the published ones. The Settings dialog
// lists them in its sidebar.

/** One plugin's page. */
export function PluginPage({
  plugin,
  host,
  running,
  onEnabled,
  shortcutsBefore = [],
}: {
  plugin: InstalledPlugin;
  host: PluginHost;
  /** The plugin as it runs for this deck, if it does: its actions need it. */
  running?: LoadedPlugin;
  /** It was just switched on. */
  onEnabled?: (plugin: LoadedPlugin) => void;
  /** Enabled plugins listed before this one, whose shortcuts win a shared key. */
  shortcutsBefore?: PluginShortcutSet[];
}) {
  const { entry, error } = plugin;
  const loaded = plugin.plugin;
  const manifest = loaded?.manifest ?? null;
  const pluginId = loaded?.id ?? entry.id ?? entry.key;
  const [keymap] = useSetting("keybindings");
  const settings = manifest ? Object.keys(manifest.contributes.settings) : [];
  const actions = manifest?.contributes.buttons.filter((b) => b.location === "settings") ?? [];
  // Its shortcuts as they're bound now, with any key Presio (or an earlier
  // plugin) already uses: that one never reaches it, so say so here, where
  // the plugin was just added.
  const shortcuts = (manifest?.contributes.keybindings ?? []).map((k) => {
    const keys = pluginBindings(keymap, pluginId, k);
    const clash = keys.map((b) => ({ b, by: shortcutTakenBy(keymap, b, shortcutsBefore) })).find((c) => c.by);
    return { command: k.command, title: findCommand(manifest!, k.command)?.title ?? k.command, keys, clash };
  });
  const details = [
    manifest && `v${manifest.version}`,
    manifest?.author && `by ${manifest.author}`,
    describeEntry(entry),
    entry.session && "this tab only",
  ].filter(Boolean);
  const update = useUpdateInfo(entry.key);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5">
        <div className="min-w-0 text-sm">
          <div className="font-medium">{entry.enabled ? "Enabled" : "Disabled"}</div>
          <div className="text-xs text-muted-foreground truncate">{details.join(" · ")}</div>
        </div>
        <Switch
          checked={entry.enabled}
          label={`Enable ${pluginLabel(plugin)}`}
          testId={`plugin-toggle-${pluginId}`}
          onChange={(on) => {
            setPluginEnabled(entry.key, on);
            if (on && loaded) onEnabled?.(loaded);
          }}
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <PluginUpdates entryKey={entry.key} version={manifest?.version} update={update} />

      {manifest && (
        <div className="space-y-1.5">
          <h4 className="text-sm font-medium">It can</h4>
          <PluginAccess
            manifest={manifest}
            shortcuts={shortcuts.map((k) => (
              <li key={k.command}>
                {k.title}
                {k.keys.length > 0 && ` (${k.keys.map(formatBinding).join(", ")})`}
              </li>
            ))}
          />
          {shortcuts.map(
            (k) =>
              k.clash && (
                <p key={k.command} className="text-xs text-amber-600 dark:text-amber-400" data-testid={`plugin-shortcut-clash-${k.command}`}>
                  {formatBinding(k.clash.b)} for {k.title} is already {k.clash.by}, which wins — rebind it under Keyboard shortcuts.
                </p>
              )
          )}
        </div>
      )}

      {actions.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">Actions</h4>
          <div className="flex flex-wrap gap-2">
            {running ? (
              <PluginButtons host={host} plugins={[running]} location="settings" />
            ) : (
              actions.map((b) => (
                <Button key={b.command} size="sm" variant="outline" disabled>
                  {b.label ?? findCommand(manifest!, b.command)?.title ?? b.command}
                </Button>
              ))
            )}
          </div>
          {!running && (
            <p className="text-xs text-muted-foreground">
              {entry.enabled ? "Available once it runs for this deck." : "Enable the plugin to use these."}
            </p>
          )}
        </div>
      )}

      {manifest && settings.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-sm font-medium">Settings</h4>
          <PluginSettingsForm pluginId={pluginId} specs={manifest.contributes.settings} />
        </div>
      )}

      {!entry.builtin && (
        <Button size="sm" variant="outline" onClick={() => removePlugin(entry.key)}>
          <Trash2 size={14} className="mr-1" />
          Remove plugin
        </Button>
      )}
    </div>
  );
}

type OnAdded = (key: string, plugin: LoadedPlugin) => void;

/** Add a plugin by its source, through the trust prompt like a ?plugins= link. */
function addPlugin(input: string, onAdded: OnAdded) {
  requestPlugin(input, {
    reason: "add",
    onDone: ({ choice, key, plugin }) => {
      if (choice === "skip" || !key || !plugin) return;
      onAdded(key, plugin);
    },
  });
}

/** The page for adding a plugin by its source. */
export function AddPluginPage({ onAdded, onDiscover }: { onAdded?: OnAdded; onDiscover?: () => void }) {
  const [url, setUrl] = useState("");

  const add = () => {
    const input = url.trim();
    if (!input) return;
    addPlugin(input, (key, plugin) => {
      setUrl("");
      onAdded?.(key, plugin);
    });
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1.5">
        <div className="flex gap-2">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && url) add(); }}
            placeholder="owner/name or https://…"
            title={'owner/name@v1.2.0 pins a version (or a range like ^1.0.0); @main follows the branch. A URL can be a dev server, http://localhost:5174/.'}
            data-testid="plugin-url-input"
            className={`flex-1 min-w-0 ${fieldClass}`}
          />
          <Button size="sm" disabled={!url} onClick={add}>
            Add
          </Button>
        </div>
        {onDiscover && (
          <p className="text-xs text-muted-foreground">
            Looking for one?{" "}
            <button type="button" onClick={onDiscover} className="text-foreground underline underline-offset-2 hover:no-underline">
              Discover plugins
            </button>
          </p>
        )}
      </div>
      <BuildWithAgent />
    </div>
  );
}

/** The page of published plugins: GitHub repos tagged presio-plugin, most
 *  starred first. */
export function DiscoverPluginsPage({ onAdded }: { onAdded?: OnAdded }) {
  const discovery = useDiscoveredPlugins();
  const entries = usePluginEntries();
  const installed = new Set(entries.map((e) => e.key.toLowerCase()));
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = (p: DiscoveredPlugin) =>
    !q || [p.id, p.repo, p.description ?? "", ...p.topics].some((text) => text.toLowerCase().includes(q));

  return (
    <div className="space-y-2" data-testid="plugin-discover">
      {discovery.status === "ready" && discovery.plugins.length > 5 && (
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search plugins"
          aria-label="Search plugins"
          className={`w-full ${fieldClass}`}
        />
      )}
      {discovery.status === "loading" && <p className="text-xs text-muted-foreground">Looking for plugins…</p>}
      {discovery.status === "error" && <p className="text-xs text-muted-foreground">{discovery.error}</p>}
      {discovery.status === "ready" &&
        (discovery.plugins.filter(matches).length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {discovery.plugins.length ? "No plugin matches." : "No plugins published yet."}
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {discovery.plugins.filter(matches).map((p) => {
              const added = installed.has(p.source.toLowerCase());
              return (
                <li key={p.source} className="flex items-center gap-3 px-3 py-2" data-testid={`plugin-discover-${p.id}`}>
                  {p.avatarUrl && <img src={p.avatarUrl} alt="" className="size-6 shrink-0 rounded-full" />}
                  <div className="min-w-0 flex-1 text-sm">
                    <div className="flex items-center gap-2">
                      <a href={p.htmlUrl} target="_blank" rel="noreferrer" className="truncate font-medium hover:underline">
                        {p.id}
                      </a>
                      <span className="flex shrink-0 items-center gap-0.5 text-xs text-muted-foreground">
                        <Star className="size-3" /> {p.stars.toLocaleString()}
                      </span>
                    </div>
                    {p.description && <div className="truncate text-xs text-muted-foreground">{p.description}</div>}
                  </div>
                  <Button size="sm" variant="outline" disabled={added} onClick={() => addPlugin(p.source, (key, plugin) => onAdded?.(key, plugin))}>
                    {added ? "Added" : "Add"}
                  </Button>
                </li>
              );
            })}
          </ul>
        ))}
    </div>
  );
}

function BuildWithAgent() {
  const [what, setWhat] = useState("");
  const [copied, setCopied] = useState(false);
  const prompt = agentPrompt(what);
  const copy = () => {
    navigator.clipboard.writeText(prompt).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => {}
    );
  };
  return (
    <section className="space-y-2" data-testid="plugin-agent-prompt">
      <div>
        <h3 className="text-sm font-medium">Build one with your agent</h3>
        <p className="text-xs text-muted-foreground">Copy a prompt for Claude Code, Codex or Cursor.</p>
      </div>
      <div className="flex gap-2">
        <input
          value={what}
          onChange={(e) => setWhat(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") copy(); }}
          placeholder="What should it do?"
          aria-label="What the plugin should do"
          className={`flex-1 min-w-0 ${fieldClass}`}
        />
        <Button size="sm" variant="outline" onClick={copy} title={prompt} aria-label="Copy the prompt">
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "Copied" : "Copy prompt"}
        </Button>
      </div>
    </section>
  );
}

/** "Updated to v1.3.0", or a newer version waiting for the presenter. */
function PluginUpdates({ entryKey, version, update }: { entryKey: string; version?: string; update?: UpdateInfo }) {
  const updated = update?.updated && version && update.updated.to.replace(/^v/, "") === version ? update.updated : null;
  if (!updated && !update?.available) return null;
  return (
    <div className="space-y-1.5 text-sm" data-testid="plugin-updates">
      {updated && (
        <p className="text-muted-foreground">
          Updated to {updated.to}
          {updated.from && ` from ${updated.from}`} on {new Date(updated.at).toLocaleDateString()}.
        </p>
      )}
      {update?.available && (
        <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
          <span>{update.available} is available.</span>
          <Button size="sm" variant="outline" onClick={() => promptUpdate(entryKey, update.available!)}>
            Update…
          </Button>
        </div>
      )}
    </div>
  );
}

/** A plugin's contributed settings, as a form generated from their specs. */
function PluginSettingsForm({ pluginId, specs }: { pluginId: string; specs: Record<string, PluginSettingSpec> }) {
  const doc = useSettingsDocument();
  const values = resolvePluginSettings(pluginId, specs, doc);
  return (
    <div className="space-y-4" data-testid={`plugin-settings-${pluginId}`}>
      {Object.entries(specs).map(([name, spec]) => (
        <SettingField
          key={name}
          id={qualify(pluginId, name)}
          spec={spec}
          value={values[name]}
          onChange={(v) => setPluginSetting(pluginId, name, spec, v)}
        />
      ))}
    </div>
  );
}

const fieldClass =
  "h-8 rounded-md border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

function SettingField({
  id,
  spec,
  value,
  onChange,
}: {
  /** The full settings key, shown so it can be found in settings.json. */
  id: string;
  spec: PluginSettingSpec;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const label = (
    <span className="block min-w-0">
      {spec.description && <span className="block text-sm">{spec.description}</span>}
      <span className="block text-xs font-mono text-muted-foreground">{id}</span>
    </span>
  );

  if (spec.type === "boolean") {
    return (
      <label className="flex items-start gap-2.5 cursor-pointer">
        <input
          type="checkbox"
          className="mt-1"
          checked={value === true}
          data-testid={`setting-${id}`}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </label>
    );
  }

  return (
    <label className="block space-y-1.5">
      {label}
      {spec.type === "enum" ? (
        <select
          value={String(value)}
          data-testid={`setting-${id}`}
          onChange={(e) => onChange(e.target.value)}
          className={`w-full ${fieldClass}`}
        >
          {spec.values.map((v, i) => (
            <option key={v} value={v}>{spec.labels?.[i] ?? v}</option>
          ))}
        </select>
      ) : spec.type === "number" ? (
        <input
          type="number"
          // Keyed by the stored value, so an outside change (an import) shows
          // up, while typing stays uncontrolled until the number is valid.
          key={String(value)}
          defaultValue={value === null ? "" : String(value)}
          min={spec.minimum}
          max={spec.maximum}
          data-testid={`setting-${id}`}
          onBlur={(e) => {
            const raw = e.target.value.trim();
            if (raw === "" && spec.default === null) onChange(null);
            else if (raw !== "" && Number.isFinite(Number(raw))) onChange(Number(raw));
          }}
          className={`w-full ${fieldClass}`}
        />
      ) : (
        <input
          type="text"
          key={String(value)}
          defaultValue={String(value ?? "")}
          maxLength={spec.maxLength}
          data-testid={`setting-${id}`}
          onBlur={(e) => onChange(e.target.value)}
          className={`w-full ${fieldClass}`}
        />
      )}
    </label>
  );
}
