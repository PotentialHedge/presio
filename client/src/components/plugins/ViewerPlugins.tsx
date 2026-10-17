import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, X } from "lucide-react";
import { useIsMobile } from "@/hooks/useIsMobile";
import { cn } from "@/lib/utils";
import type { PluginHost } from "@/lib/plugins/host";
import { findCommand, type LoadedPlugin } from "@/lib/plugins/manifest";
import { runsOnViewer, type ViewerPluginSwitches } from "@/lib/plugins/viewerSwitches";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { PluginFrame } from "./PluginFrame";
import { PluginMenuEntries } from "./PresenterPlugins";
import { pluginIcon } from "./icons";

// The audience's side of plugins, drawn by Presio around their frames: the
// viewer sheet, the buttons on the viewer's toolbar, and the list where a
// viewer turns a plugin off on their own device.

/** How far down a sheet has to be dragged to close it (px). */
const DISMISS_DRAG = 80;

/**
 * Viewer sheets: each plugin with a "viewerSheet" surface gets a frame,
 * mounted (so it can listen) and shown while the plugin asks for it
 * (presio.ui.setVisible). On a phone it's a bottom sheet; on a wide screen, a
 * card beside the slide. The viewer can close it (the ✕, Esc, or a drag down
 * on a phone), which the plugin hears. One is on screen at a time: the one
 * opened last, with the others back in turn as it closes.
 */
export function ViewerSheets({ host, plugins }: { host: PluginHost; plugins: LoadedPlugin[] }) {
  const sheets = plugins.filter((p) => p.manifest.surfaces.includes("viewerSheet"));
  // Open sheets' plugin ids, the most recently opened last.
  const [open, setOpen] = useState<string[]>([]);
  const phone = useIsMobile(640);
  const top = open.length ? open[open.length - 1] : null;

  const setVisible = (pluginId: string, visible: boolean) =>
    setOpen((prev) => {
      const rest = prev.filter((id) => id !== pluginId);
      if (!visible) return rest.length === prev.length ? prev : rest;
      return prev[prev.length - 1] === pluginId ? prev : [...rest, pluginId];
    });

  useEffect(() => {
    if (!top) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      setOpen((prev) => prev.filter((id) => id !== top));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [top]);

  return (
    <>
      {sheets.map((plugin) => (
        <ViewerSheet
          key={plugin.hash}
          host={host}
          plugin={plugin}
          phone={phone}
          open={open.includes(plugin.id)}
          onScreen={top === plugin.id}
          onVisibleChange={(visible) => setVisible(plugin.id, visible)}
        />
      ))}
    </>
  );
}

function ViewerSheet({
  host,
  plugin,
  phone,
  open,
  onScreen,
  onVisibleChange,
}: {
  host: PluginHost;
  plugin: LoadedPlugin;
  phone: boolean;
  /** The plugin has it open (it may be waiting behind another). */
  open: boolean;
  onScreen: boolean;
  onVisibleChange: (visible: boolean) => void;
}) {
  // The plugin's document's height, which the sheet fits (up to a cap).
  const [contentHeight, setContentHeight] = useState(0);
  // A drag down on a phone sheet's header, in px.
  const [drag, setDrag] = useState<number | null>(null);
  const dragStart = useRef(0);
  const { displayName } = plugin.manifest;
  const cap = phone ? "70dvh" : "calc(100dvh - 10rem)";

  const endDrag = () => {
    if (drag !== null && drag > DISMISS_DRAG) onVisibleChange(false);
    setDrag(null);
  };

  return (
    <section
      aria-label={displayName}
      aria-hidden={!onScreen}
      inert={!onScreen}
      data-testid={`viewer-sheet-${plugin.id}`}
      data-open={onScreen || undefined}
      className={cn(
        "fixed z-40 flex flex-col overflow-hidden border bg-card text-card-foreground shadow-2xl",
        drag === null && "transition-[transform,opacity] duration-200 ease-out",
        phone
          ? "inset-x-0 bottom-0 rounded-t-2xl border-b-0 pb-[env(safe-area-inset-bottom)]"
          : "right-4 top-16 w-[22rem] max-w-[calc(100vw-2rem)] rounded-xl",
        !onScreen && "pointer-events-none opacity-0",
        !onScreen && (phone ? "translate-y-full" : "translate-x-[calc(100%+2rem)]")
      )}
      style={drag ? { transform: `translateY(${drag}px)` } : undefined}
    >
      <header
        className={cn("relative flex items-center gap-2 pl-4 pr-2", phone ? "pt-3 pb-1 touch-none" : "py-1.5 border-b")}
        onPointerDown={(e) => {
          if (!phone || (e.target as HTMLElement).closest("button")) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          dragStart.current = e.clientY;
          setDrag(0);
        }}
        onPointerMove={(e) => {
          if (drag !== null) setDrag(Math.max(0, e.clientY - dragStart.current));
        }}
        onPointerUp={endDrag}
        onPointerCancel={() => setDrag(null)}
      >
        {phone && <span aria-hidden className="absolute left-1/2 top-1.5 h-1 w-9 -translate-x-1/2 rounded-full bg-muted-foreground/30" />}
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium">{displayName}</h2>
        <button
          type="button"
          aria-label={`Close ${displayName}`}
          data-testid={`viewer-sheet-close-${plugin.id}`}
          onClick={() => onVisibleChange(false)}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <X size={16} />
        </button>
      </header>
      <PluginFrame
        host={host}
        plugin={plugin}
        surface="viewerSheet"
        visible={open}
        onVisibleChange={onVisibleChange}
        onContentSize={setContentHeight}
        className="block w-full shrink-0 transition-[height] duration-150"
        // Until the plugin says how tall it is, a sensible size.
        style={{ height: `min(${contentHeight || 160}px, ${cap})` }}
      />
    </section>
  );
}

/**
 * Plugins' viewer.toolbar buttons: pills beside the viewer's menu button, in
 * the same glass as the rest of the viewer's chrome. Each runs its command in
 * this device's frames (the plugin's sheet, layer or slide surface).
 */
export function ViewerToolbar({ host, plugins }: { host: PluginHost; plugins: LoadedPlugin[] }) {
  return (
    <>
      {plugins.map((plugin) =>
        plugin.manifest.contributes.buttons.some((b) => b.location === "viewer.toolbar") ? (
          <ViewerToolbarGroup key={plugin.hash} host={host} plugin={plugin} />
        ) : null
      )}
    </>
  );
}

const PILL = "inline-flex h-9 items-center gap-1.5 text-xs font-medium backdrop-blur drop-shadow-md transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default";

function ViewerToolbarGroup({ host, plugin }: { host: PluginHost; plugin: LoadedPlugin }) {
  const { id, manifest } = plugin;
  const states = useSyncExternalStore(host.subscribeButtons, () => host.buttonStates(id));
  return (
    <>
      {manifest.contributes.buttons
        .filter((b) => b.location === "viewer.toolbar" && !states[b.command]?.hidden)
        .map((b) => {
          const command = findCommand(manifest, b.command);
          const state = states[b.command] ?? {};
          const label = state.label ?? b.label ?? command?.title ?? b.command;
          const Icon = pluginIcon(b.icon ?? command?.icon);
          const tone = state.active ? "bg-white/90 text-black hover:bg-white" : "bg-black/30 text-white hover:bg-black/45";
          const main = (
            <button
              key={b.command}
              type="button"
              disabled={state.disabled}
              aria-pressed={state.active}
              aria-label={label}
              title={`${b.tooltip ?? label} (${manifest.displayName})`}
              data-testid={`plugin-button-${id}-${b.command}`}
              onClick={() => host.runCommand(id, b.command)}
              className={cn(PILL, tone, state.menu ? "rounded-l-full pl-3 pr-2" : "rounded-full px-3")}
            >
              {Icon && <Icon size={15} />}
              {/* On a phone an icon says it; the label is its name. */}
              <span className={cn(Icon && "hidden sm:inline")}>{label}</span>
            </button>
          );
          if (!state.menu) return main;
          return (
            <span key={b.command} className="inline-flex">
              {main}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    aria-label={`${label} options`}
                    data-testid={`plugin-menu-${id}-${b.command}`}
                    className={cn(PILL, tone, "rounded-r-full border-l border-white/15 pl-1.5 pr-2.5")}
                  >
                    <ChevronDown size={14} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-w-80">
                  <PluginMenuEntries host={host} pluginId={id} command={b.command} entries={state.menu} />
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          );
        })}
    </>
  );
}

/**
 * "Plugins in this session": what the presenter runs on viewers, each with a
 * switch that turns it off on this device only. Nothing when there are none.
 */
export function ViewerPluginList({ plugins, switches }: { plugins: LoadedPlugin[]; switches: ViewerPluginSwitches }) {
  const list = plugins.filter((p) => runsOnViewer(p.manifest));
  if (!list.length) return null;
  return (
    <div className="space-y-1.5" data-testid="viewer-plugin-list">
      <h3 className="text-xs font-medium text-muted-foreground">Plugins in this session</h3>
      <div className="divide-y rounded-lg border">
        {list.map((plugin) => {
          const { displayName, author, version } = plugin.manifest;
          const on = !switches.isOff(plugin.id);
          return (
            <div key={plugin.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className={cn("truncate text-sm font-medium", !on && "text-muted-foreground")}>{displayName}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {author ? `${author} · ` : ""}v{version}
                </p>
              </div>
              <Switch
                checked={on}
                onChange={(next) => switches.setOff(plugin.id, !next)}
                label={`${displayName} on this device`}
                testId={`viewer-plugin-switch-${plugin.id}`}
              />
            </div>
          );
        })}
      </div>
      <p className="text-[11px] text-muted-foreground">Turning one off only affects this device.</p>
    </div>
  );
}
