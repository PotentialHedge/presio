import { useSyncExternalStore } from "react";
import {
  BarChart3,
  Bell,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  Eye,
  Hand,
  Megaphone,
  MessageSquare,
  PenLine,
  QrCode,
  Sparkles,
  Star,
  Timer,
  Upload,
  Users,
  type LucideIcon,
} from "lucide-react";
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
import { findCommand, type ButtonContribution, type ButtonLocation, type LoadedPlugin } from "@/lib/plugins/manifest";
import { PluginFrame } from "./PluginFrame";

// The presenter's side of plugins, drawn by Presio from what each plugin
// declares: its panels, its hidden background frame, and the buttons that run
// its commands.

const ICONS: Record<string, LucideIcon> = {
  "qr-code": QrCode,
  "bar-chart": BarChart3,
  message: MessageSquare,
  users: Users,
  timer: Timer,
  bell: Bell,
  star: Star,
  sparkles: Sparkles,
  hand: Hand,
  check: Check,
  eye: Eye,
  megaphone: Megaphone,
  pen: PenLine,
  download: Download,
  upload: Upload,
};

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

/**
 * Press a plugin's button: run its command. One that asks for a file is
 * picked here, by Presio: the click is Presio's, and a plugin's frame
 * couldn't open a file picker on it.
 */
function press(host: PluginHost, pluginId: string, button: ButtonContribution) {
  if (!button.accept) return host.pressButton(pluginId, button.command);
  const input = document.createElement("input");
  input.type = "file";
  input.accept = button.accept;
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    host.pressButton(pluginId, button.command, { name: file.name, type: file.type, bytes });
  };
  input.click();
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
          const Icon = button.icon ? ICONS[button.icon] : undefined;
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
              data-testid={`plugin-menu-item-${pluginId}-${button.command}-${i}`}
              onSelect={() => host.pickMenuItem(pluginId, button.command, entry.id)}
            >
              <span className="truncate">{entry.label}</span>
            </DropdownMenuCheckboxItem>
          )
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
