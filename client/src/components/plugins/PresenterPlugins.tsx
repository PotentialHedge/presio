import { useSyncExternalStore } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { ButtonMenuEntry, PluginHost } from "@/lib/plugins/host";
import { ContextMenuItem, ContextMenuLabel, ContextMenuSeparator } from "@/components/ui/context-menu";
import { findCommand, type ButtonContribution, type ButtonLocation, type LoadedPlugin } from "@/lib/plugins/manifest";
import { PluginFrame } from "./PluginFrame";
import { pluginIcon } from "./icons";
import { runPluginCommand } from "./pluginCommands";

// The presenter's side of plugins, drawn by Presio from what each plugin
// declares: its panels, its hidden background frame, the buttons that run
// its commands, its status items and its thumbnail menu entries.

/** One of a plugin's panels, in its dashboard card. */
export function PluginPanel({ host, plugin, panel }: { host: PluginHost; plugin: LoadedPlugin; panel: string }) {
  return <PluginFrame host={host} plugin={plugin} surface="panel" panel={panel} className="w-full h-full" />;
}

/** Background surfaces: mounted for as long as the deck is open, never shown. */
export function PluginBackgrounds({ host, plugins }: { host: PluginHost; plugins: LoadedPlugin[] }) {
  return (
    <div className="hidden" aria-hidden>
      {plugins
        .filter((p) => p.manifest.surfaces.includes("background"))
        .map((plugin) => (
          <PluginFrame key={plugin.hash} host={host} plugin={plugin} surface="background" />
        ))}
    </div>
  );
}

/** Every plugin's contributed buttons for one place in the interface. */
export function PluginButtons({
  host,
  plugins,
  location,
}: {
  host: PluginHost;
  plugins: LoadedPlugin[];
  location: ButtonLocation;
}) {
  return (
    <>
      {plugins.map((plugin) =>
        plugin.manifest.contributes.buttons.some((b) => b.location === location) ? (
          <PluginButtonGroup key={plugin.hash} host={host} plugin={plugin} location={location} />
        ) : null
      )}
    </>
  );
}

/** Press a plugin's button: run its command (asking for a file first, for
 *  a button with "accept"). */
function press(host: PluginHost, pluginId: string, button: ButtonContribution) {
  runPluginCommand(host, pluginId, button.command, { accept: button.accept });
}

function PluginButtonGroup({ host, plugin, location }: { host: PluginHost; plugin: LoadedPlugin; location: ButtonLocation }) {
  const { id, manifest } = plugin;
  const name = manifest.displayName;
  const states = useSyncExternalStore(host.subscribeButtons, () => host.buttonStates(id));
  return (
    <>
      {manifest.contributes.buttons
        .filter((b) => b.location === location)
        .map((b) => {
          // A button shows its command's title and icon unless it has its own.
          const command = findCommand(manifest, b.command);
          const button = { ...b, label: b.label ?? command?.title ?? b.command, icon: b.icon ?? command?.icon };
          const state = states[button.command] ?? {};
          const Icon = pluginIcon(button.icon);
          const title = `${button.tooltip ?? state.label ?? button.label} (${name})`;
          const menu = state.menu && (
            <ButtonMenu
              host={host}
              pluginId={id}
              button={button}
              entries={state.menu}
              label={state.label ?? button.label}
              active={state.active}
              location={location}
            />
          );
          if (location === "controller.currentSlide") {
            // A card header's small icon action; the label is its tooltip.
            const icon = (
              <button
                key={button.command}
                type="button"
                disabled={state.disabled}
                aria-pressed={state.active}
                aria-label={state.label ?? button.label}
                data-testid={`plugin-button-${id}-${button.command}`}
                title={title}
                onClick={() => press(host, id, button)}
                className={cn(
                  "inline-flex items-center justify-center h-5 min-w-5 px-0.5 rounded transition-colors disabled:opacity-40",
                  state.active ? "text-foreground bg-accent" : "text-muted-foreground hover:text-foreground hover:bg-accent"
                )}
              >
                {Icon ? <Icon size={13} /> : <span className="text-[11px]">{state.label ?? button.label}</span>}
              </button>
            );
            return menu ? (
              <span key={button.command} className="inline-flex items-center">
                {icon}
                {menu}
              </span>
            ) : (
              icon
            );
          }
          // Settings page actions are plain buttons; the toolbar's show their state.
          const inSettings = location === "settings";
          const main = (
            <Button
              key={button.command}
              variant={inSettings ? "outline" : state.active ? "default" : "ghost"}
              size="sm"
              disabled={state.disabled}
              aria-pressed={inSettings ? undefined : state.active}
              data-testid={`plugin-button-${id}-${button.command}`}
              title={inSettings ? button.tooltip : title}
              onClick={() => press(host, id, button)}
            >
              {Icon && <Icon size={14} className="mr-1" />}
              {state.label ?? button.label}
            </Button>
          );
          return menu ? (
            <ButtonGroup key={button.command}>
              {main}
              {menu}
            </ButtonGroup>
          ) : (
            main
          );
        })}
    </>
  );
}

/**
 * The small menu a plugin can put beside one of its buttons (setButton's
 * `menu`): a chevron that opens it, a pick running the button's command
 * with { menuItem }. It opens
 * upward from the bottom bar, like Download PDF's.
 */
function ButtonMenu({
  host,
  pluginId,
  button,
  entries,
  label,
  active,
  location,
}: {
  host: PluginHost;
  pluginId: string;
  button: ButtonContribution & { label: string };
  entries: ButtonMenuEntry[];
  label: string;
  /** The button's own state, which the toolbar's chevron matches. */
  active?: boolean;
  location: ButtonLocation;
}) {
  const up = location === "controller.toolbar";
  const Chevron = up ? ChevronUp : ChevronDown;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {location === "controller.currentSlide" ? (
          <button
            type="button"
            aria-label={`${label} options`}
            data-testid={`plugin-menu-${pluginId}-${button.command}`}
            className="inline-flex items-center justify-center h-5 w-3.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent"
          >
            <Chevron size={11} />
          </button>
        ) : (
          <Button
            type="button"
            variant={location === "settings" ? "outline" : active ? "default" : "ghost"}
            size="sm"
            aria-label={`${label} options`}
            data-testid={`plugin-menu-${pluginId}-${button.command}`}
            className="px-1.5"
          >
            <Chevron size={14} />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent side={up ? "top" : "bottom"} align="end" className="max-w-80">
        <PluginMenuEntries host={host} pluginId={pluginId} command={button.command} entries={entries} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The rows of a button's menu (setButton's `menu`), inside a DropdownMenuContent;
 *  a pick runs the button's command with { menuItem }. */
export function PluginMenuEntries({
  host,
  pluginId,
  command,
  entries,
}: {
  host: PluginHost;
  pluginId: string;
  command: string;
  entries: ButtonMenuEntry[];
}) {
  return (
    <>
      {entries.map((entry, i) =>
        "separator" in entry ? (
          <DropdownMenuSeparator key={i} />
        ) : "heading" in entry ? (
          <DropdownMenuLabel key={i} className="text-xs text-muted-foreground font-normal">
            {entry.heading}
          </DropdownMenuLabel>
        ) : (
          <DropdownMenuCheckboxItem
            key={i}
            checked={entry.checked ?? false}
            disabled={entry.disabled}
            data-testid={`plugin-menu-item-${pluginId}-${command}-${i}`}
            onSelect={() => host.pickMenuItem(pluginId, command, entry.id)}
          >
            <span className="truncate">{entry.label}</span>
          </DropdownMenuCheckboxItem>
        )
      )}
    </>
  );
}

/**
 * Running plugins' status items (contributes.status) for the controller's
 * header: small text the plugin sets at runtime ("12 votes"), hidden until
 * it does. One bound to a command runs it on a click.
 */
export function PluginStatusItems({ host, plugins, compact = false }: { host: PluginHost; plugins: LoadedPlugin[]; compact?: boolean }) {
  useSyncExternalStore(host.subscribeStatus, host.statusRevision);
  const items = plugins.flatMap((plugin) => {
    const set = host.statusItems(plugin.id);
    return plugin.manifest.contributes.status.flatMap((decl) => {
      const state = set[decl.id];
      return state ? [{ plugin, id: decl.id, state, tooltip: state.tooltip ?? decl.tooltip }] : [];
    });
  });
  if (!items.length) return null;
  return (
    <div className="flex min-w-0 items-center gap-0.5" data-testid="plugin-status-items">
      {items.map(({ plugin, id, state, tooltip }) => {
        const Icon = pluginIcon(state.icon);
        const title = `${tooltip ?? state.text} (${plugin.manifest.displayName})`;
        const content = (
          <>
            {Icon && <Icon size={13} className="shrink-0" />}
            <span className="truncate tabular-nums">{state.text}</span>
          </>
        );
        const className = cn(
          "inline-flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground",
          compact ? "max-w-24" : "max-w-48"
        );
        const testId = `plugin-status-${plugin.id}-${id}`;
        const command = state.command;
        if (!command) {
          return (
            <span key={`${plugin.id}:${id}`} title={title} className={className} data-testid={testId}>
              {content}
            </span>
          );
        }
        return (
          <button
            key={`${plugin.id}:${id}`}
            type="button"
            title={title}
            data-testid={testId}
            onClick={() => host.runCommand(plugin.id, command, isRecord(state.args) ? state.args : {})}
            className={cn(className, "hover:bg-accent hover:text-foreground transition-colors")}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Running plugins' entries in a thumbnail's context menu (thumbnail.context
 * buttons), each group under its plugin's name; the command runs with
 * { slide }. Renders nothing when no plugin adds one.
 */
export function PluginThumbnailMenuItems({ host, plugins, slide }: { host: PluginHost; plugins: LoadedPlugin[]; slide: number }) {
  const groups = plugins
    .map((plugin) => ({ plugin, buttons: plugin.manifest.contributes.buttons.filter((b) => b.location === "thumbnail.context") }))
    .filter((g) => g.buttons.length);
  return (
    <>
      {groups.map(({ plugin, buttons }) => {
        const states = host.buttonStates(plugin.id);
        return (
          <div key={plugin.hash}>
            <ContextMenuSeparator />
            <ContextMenuLabel>{plugin.manifest.displayName}</ContextMenuLabel>
            {buttons.map((b) => {
              const command = findCommand(plugin.manifest, b.command);
              const state = states[b.command] ?? {};
              const Icon = pluginIcon(b.icon ?? command?.icon);
              return (
                <ContextMenuItem
                  key={b.command}
                  disabled={state.disabled}
                  title={b.tooltip}
                  data-testid={`plugin-context-${plugin.id}-${b.command}`}
                  onSelect={() => runPluginCommand(host, plugin.id, b.command, { accept: b.accept, args: { slide } })}
                >
                  {Icon ? <Icon /> : <span className="size-4" />}
                  {state.label ?? b.label ?? command?.title ?? b.command}
                </ContextMenuItem>
              );
            })}
          </div>
        );
      })}
    </>
  );
}
