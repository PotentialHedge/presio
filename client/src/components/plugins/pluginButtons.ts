// Plugins' buttons as Presio draws them, shared by the controller's
// (PresenterPlugins.tsx) and the VS Code preview's toggles (embed/).

import { useSyncExternalStore } from "react";
import type { ButtonState, PluginHost } from "@/lib/plugins/host";
import { findCommand, type ButtonContribution, type ButtonLocation, type LoadedPlugin } from "@/lib/plugins/manifest";
import { pluginIcon } from "./icons";
import { runPluginCommand } from "./pluginCommands";

/** Press a plugin's button: run its command (asking for a file first, for
 *  a button with "accept"). */
export function pressPluginButton(host: PluginHost, pluginId: string, button: ButtonContribution) {
  runPluginCommand(host, pluginId, button.command, { accept: button.accept });
}

/** A plugin's buttons for one place, as drawn: each with the label and icon
 *  it shows (its own, else its command's), its state and its tooltip. Ones
 *  the plugin hid are left out. */
export function resolvePluginButtons(plugin: LoadedPlugin, location: ButtonLocation, states: Record<string, ButtonState>) {
  const { manifest } = plugin;
  return manifest.contributes.buttons
    .filter((b) => b.location === location && !states[b.command]?.hidden)
    .map((b) => {
      const command = findCommand(manifest, b.command);
      const button = { ...b, label: b.label ?? command?.title ?? b.command, icon: b.icon ?? command?.icon };
      const state = states[button.command] ?? {};
      return {
        button,
        state,
        Icon: pluginIcon(button.icon),
        title: `${button.tooltip ?? state.label ?? button.label} (${manifest.displayName})`,
      };
    });
}

/** One plugin's button states, kept current. */
export function usePluginButtonStates(host: PluginHost, pluginId: string): Record<string, ButtonState> {
  return useSyncExternalStore(host.subscribeButtons, () => host.buttonStates(pluginId));
}
