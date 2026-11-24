// The preview footer's toggles: Presio's panels and the plugins' buttons
// alike. On looks like VS Code's own toggles (the find widget's Match Case),
// and hovering never fills a button, so a click's result shows at once, under
// the pointer.

import type { LucideIcon } from "lucide-react";
import type { PluginHost } from "@/lib/plugins/host";
import type { LoadedPlugin } from "@/lib/plugins/manifest";
import { pressPluginButton, resolvePluginButtons, usePluginButtonStates } from "@/components/plugins/pluginButtons";
import { cn } from "@/lib/utils";

export function ToggleButton({
  icon: Icon,
  label,
  title = label,
  active = false,
  disabled,
  onClick,
  testId,
}: {
  icon?: LucideIcon;
  /** What it toggles, for screen readers; also shown when there's no icon. */
  label: string;
  title?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={label}
      title={title}
      disabled={disabled}
      data-testid={testId}
      onClick={onClick}
      className={cn(
        "inline-flex items-center justify-center h-7 min-w-7 px-1 rounded border disabled:opacity-40",
        active
          ? "bg-(--toggle-on-bg) border-(--toggle-on-border) text-(--toggle-on-fg)"
          : // Hover only outlines an off toggle, never fills it: a fill means on.
            "border-transparent text-muted-foreground hover:border-(--toggle-hover-border) hover:text-foreground"
      )}
    >
      {Icon ? <Icon className="size-4" /> : <span className="text-xs">{label}</span>}
    </button>
  );
}

/** The plugins' buttons for under the current slide, as toggles. */
export function PluginToggles({ host, plugins }: { host: PluginHost; plugins: LoadedPlugin[] }) {
  return (
    <>
      {plugins.map((plugin) => (
        <PluginToggleGroup key={plugin.hash} host={host} plugin={plugin} />
      ))}
    </>
  );
}

function PluginToggleGroup({ host, plugin }: { host: PluginHost; plugin: LoadedPlugin }) {
  const states = usePluginButtonStates(host, plugin.id);
  return (
    <>
      {resolvePluginButtons(plugin, "controller.currentSlide", states).map(({ button, state, Icon, title }) => (
        <ToggleButton
          key={button.command}
          icon={Icon}
          label={state.label ?? button.label}
          title={title}
          active={state.active}
          disabled={state.disabled}
          onClick={() => pressPluginButton(host, plugin.id, button)}
          testId={`plugin-button-${plugin.id}-${button.command}`}
        />
      ))}
    </>
  );
}
