// Running plugins' commands from Presio's interface, and listing them in the
// command palette.

import { useSyncExternalStore } from "react";
import { formatBinding, pluginBindings, type Keymap } from "@/lib/keymap";
import type { PaletteItem } from "@/lib/commands";
import type { PluginHost } from "@/lib/plugins/host";
import type { LoadedPlugin } from "@/lib/plugins/manifest";
import { pluginIcon } from "./icons";

/**
 * Run a plugin's command from a click. One whose button asks for a file
 * (`accept`) has it picked here, by Presio: the click is Presio's, and a
 * plugin's frame couldn't open a file picker on it. The command then runs
 * with { file } added to `args`, and not at all if the picker is cancelled.
 */
export function runPluginCommand(
  host: PluginHost,
  pluginId: string,
  command: string,
  { accept, args = {} }: { accept?: string; args?: Record<string, unknown> } = {}
) {
  if (!accept) return host.runCommand(pluginId, command, args);
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    host.runCommand(pluginId, command, { ...args, file: { name: file.name, type: file.type, bytes } });
  };
  input.click();
}

/**
 * Running plugins' commands as palette rows: the ones a frame on this device
 * handles (so each row does something here), under the plugin's name or the
 * command's own category, with the presenter's key for it when `keymap` is
 * given.
 */
export function usePluginPaletteItems(host: PluginHost, plugins: LoadedPlugin[], keymap: Keymap | null): PaletteItem[] {
  // Redraw as frames register their handlers.
  useSyncExternalStore(host.subscribeCommands, host.commandRegistrations);
  return plugins.flatMap((plugin) => {
    const { id, manifest } = plugin;
    const states = host.buttonStates(id);
    return manifest.contributes.commands
      .filter((c) => host.isCommandRegistered(id, c.id))
      .map((c): PaletteItem => {
        const kb = keymap && manifest.contributes.keybindings.find((k) => k.command === c.id);
        const key = kb ? pluginBindings(keymap, id, kb)[0] : undefined;
        // A command whose button asks for a file asks for one here too.
        const accept = manifest.contributes.buttons.find((b) => b.command === c.id && b.accept)?.accept;
        return {
          id: `${id}.${c.id}`,
          title: c.title,
          category: c.category ?? manifest.displayName,
          icon: pluginIcon(c.icon),
          shortcut: key ? formatBinding(key) : undefined,
          keywords: `${manifest.displayName} ${id}`,
          disabled: states[c.id]?.disabled,
          run: () => runPluginCommand(host, id, c.id, { accept }),
        };
      });
  });
}
