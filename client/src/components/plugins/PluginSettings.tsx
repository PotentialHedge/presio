import { useState } from "react";
import { Check, Copy, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { appOrigin } from "@/lib/origins";
import type { PluginHost } from "@/lib/plugins/host";
import {
  findCommand,
  type ButtonLocation,
  type LoadedPlugin,
  type PluginPermission,
  type PluginSettingSpec,
  type PluginSurface,
} from "@/lib/plugins/manifest";
import { resolvePluginSettings, setPluginSetting, useSetting, useSettingsDocument } from "@/lib/settings";
import { formatBinding, pluginBindings, shortcutTakenBy, type PluginShortcutSet } from "@/lib/keymap";
import { describeEntry, removePlugin, setPluginEnabled } from "@/lib/plugins/registry";
import { requestPlugin } from "@/lib/plugins/prompts";
import { promptUpdate, useUpdateInfo, type UpdateInfo } from "@/lib/plugins/updates";
import { pluginLabel, type InstalledPlugin } from "@/lib/plugins/installed";
import { qualify } from "@shared/plugin/sources";
import { PluginButtons } from "./PresenterPlugins";

// Settings for plugins: one page per installed plugin (switch it on or off,
// see what it adds and may do, use its actions, edit its settings) and a page
// to add one by URL. The Settings dialog lists them in its sidebar.

const PERMISSION_LABELS: Record<PluginPermission, string> = {
  deck: "Reads the deck: its pages and attachments",
  editDeck: "Saves changes into your deck",
  history: "Keeps an edit history for the deck, shared with every screen",
  audience: "Collects input from your audience's devices",
};

const SURFACE_LABELS: Record<PluginSurface, string> = {
  background: "Runs in the background while you present",
  panel: "A card on your dashboard",
  viewerSheet: "A panel on your audience's devices",
  viewer: "A layer on every viewer's screen, including your audience's devices",
  slide: "A layer on the slide, on your current slide and every viewer's screen",
};

const LOCATION_LABELS: Record<ButtonLocation, string> = {
  "controller.toolbar": "in the bottom bar",
  "controller.currentSlide": "in the current slide's header",
  "thumbnail.context": "in a thumbnail's menu",
  "viewer.toolbar": "on your audience's toolbar",
  settings: "on this page",
};

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
  // Its actions are on this page, so the list of what it adds leaves them out.
  const actions = manifest?.contributes.buttons.filter((b) => b.location === "settings") ?? [];
  const buttons = manifest?.contributes.buttons.filter((b) => b.location !== "settings") ?? [];
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
          <h4 className="text-sm font-medium">What it adds</h4>
          <ul className="text-sm text-muted-foreground list-disc pl-5 space-y-0.5">
            {buttons.map((b) => (
              <li key={`${b.command}:${b.location}`}>
                A “{b.label ?? findCommand(manifest, b.command)?.title ?? b.command}” button {LOCATION_LABELS[b.location]}
              </li>
            ))}
            {manifest.contributes.keybindings.map((k) => {
              const keys = pluginBindings(keymap, pluginId, k);
              // A key Presio (or an earlier plugin) already uses never reaches
              // this one: say so here, where the plugin was just added.
              const clash = keys
                .map((b) => ({ b, by: shortcutTakenBy(keymap, b, shortcutsBefore) }))
                .find((c) => c.by);
              return (
                <li key={k.command}>
                  A keyboard shortcut: {findCommand(manifest, k.command)?.title ?? k.command}
                  {keys.length > 0 && ` (${keys.map(formatBinding).join(", ")})`}
                  {clash && (
                    <span className="block text-amber-600 dark:text-amber-400" data-testid={`plugin-shortcut-clash-${k.command}`}>
                      {formatBinding(clash.b)} is already {clash.by}, which wins — rebind it under Keyboard shortcuts.
                    </span>
                  )}
                </li>
              );
            })}
            {/* A background part that only serves its buttons or shortcuts
                says nothing those lines didn't already. */}
            {manifest.surfaces
              .filter((s: PluginSurface) => s !== "background" || (buttons.length === 0 && manifest.contributes.keybindings.length === 0))
              .map((s) => (
                <li key={s}>{SURFACE_LABELS[s]}</li>
              ))}
            {manifest.permissions.map((p: PluginPermission) => (
              <li key={p} className="text-amber-600 dark:text-amber-400">{PERMISSION_LABELS[p] ?? p}</li>
            ))}
          </ul>
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

/** The page for adding a plugin: its source goes through the trust prompt,
 *  like a ?plugins= link. */
export function AddPluginPage({ onAdded }: { onAdded?: (key: string, plugin: LoadedPlugin) => void }) {
  const [url, setUrl] = useState("");

  const add = () => {
    const input = url.trim();
    if (!input) return;
    requestPlugin(input, {
      reason: "add",
      onDone: ({ choice, key, plugin }) => {
        if (choice === "skip" || !key || !plugin) return;
        setUrl("");
        onAdded?.(key, plugin);
      },
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && url) add(); }}
          placeholder="you/name, github:you/repo@v1.0.0, https://… or http://localhost:5174/"
          data-testid="plugin-url-input"
          className={`flex-1 min-w-0 ${fieldClass}`}
        />
        <Button size="sm" disabled={!url} onClick={add}>
          Add
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        A version after "@" pins it (v1.2.0, or a range like ^1.0.0); a branch (@main) follows its newest commit.
      </p>
      <BuildWithAgent />
    </div>
  );
}

/** The prompt that has a coding agent build a plugin: it reads /plugins.md,
 *  makes the repo, and hands back a ?plugins= link to open. */
function agentPrompt(what: string): string {
  const task = what.trim().replace(/\.$/, "") || "…";
  return `Read ${appOrigin}/plugins.md and build me a Presio plugin that ${task}.`;
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
    <section className="mt-5 space-y-2 rounded-lg border p-3" data-testid="plugin-agent-prompt">
      <div>
        <h3 className="text-sm font-medium">Build one with your agent</h3>
        <p className="text-xs text-muted-foreground">
          Say what it should do and paste the prompt into a coding agent (Claude Code, Codex, Cursor…). It builds the
          plugin in a GitHub repo of yours and gives you a link that loads it here.
        </p>
      </div>
      <input
        value={what}
        onChange={(e) => setWhat(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") copy(); }}
        placeholder="lets viewers answer multiple-choice polls"
        aria-label="What the plugin should do"
        className={`w-full ${fieldClass}`}
      />
      <div className="flex items-start gap-2">
        <p className="flex-1 min-w-0 rounded-md bg-muted px-2.5 py-2 text-xs leading-relaxed break-words select-all">{prompt}</p>
        <Button size="sm" variant="outline" onClick={copy} aria-label="Copy the prompt">
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Load only plugins you trust: a plugin can act as you on this device. You'll be asked before it runs.
      </p>
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
