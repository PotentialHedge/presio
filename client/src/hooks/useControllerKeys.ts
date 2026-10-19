import { useEffect } from "react";
import { isEditableTarget, matchesBinding, pluginBindings, type Keymap } from "@/lib/keymap";
import type { PluginHost } from "@/lib/plugins/host";
import type { LoadedPlugin } from "@/lib/plugins/manifest";
import type { SlideJump } from "./useSlideJump";

/** The controller's keyboard: the palette, slide navigation, blanking, jumps and plugins' keys. */
export function useControllerKeys({
  keymap,
  currentSlide,
  totalSlides,
  onGoTo,
  onBlankToggle,
  togglePalette,
  jump: { pendingJump, armJump, commitJump, cancelJump },
  runningPlugins,
  pluginHost,
}: {
  keymap: Keymap;
  currentSlide: number;
  totalSlides: number;
  onGoTo: (slide: number) => void;
  onBlankToggle: () => void;
  togglePalette: () => void;
  jump: SlideJump;
  runningPlugins: readonly LoadedPlugin[];
  pluginHost: PluginHost;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // ⌘K / Ctrl+K: the command palette, from anywhere (a field included).
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        cancelJump();
        togglePalette();
        return;
      }
      if (isEditableTarget(e.target)) return;
      // While armed, every keystroke belongs to the jump: digits accumulate,
      // Enter commits, and anything else cancels rather than firing its own
      // shortcut halfway through a page number.
      if (pendingJump !== null) {
        // A bare modifier press isn't a decision either way.
        if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
        e.preventDefault();
        if (/^[0-9]$/.test(e.key)) armJump(pendingJump + e.key);
        else if (e.key === "Enter") commitJump(pendingJump);
        else cancelJump();
        return;
      }
      if (matchesBinding(e, keymap.jumpToSlide)) {
        e.preventDefault();
        armJump("");
      } else if (matchesBinding(e, keymap.firstSlide)) {
        e.preventDefault();
        onGoTo(1);
      } else if (matchesBinding(e, keymap.lastSlide)) {
        e.preventDefault();
        onGoTo(totalSlides);
      } else if (matchesBinding(e, keymap.nextSlide)) {
        e.preventDefault();
        onGoTo(currentSlide + 1);
      } else if (matchesBinding(e, keymap.prevSlide)) {
        e.preventDefault();
        onGoTo(currentSlide - 1);
      } else if (matchesBinding(e, keymap.toggleBlank)) {
        onBlankToggle();
      } else if (!e.repeat) {
        // Plugins' keybindings, after Presio's own: a key both claim is ours.
        for (const plugin of runningPlugins) {
          const { id: pluginId, manifest: { contributes } } = plugin;
          const hit = contributes.keybindings.find((kb) => matchesBinding(e, pluginBindings(keymap, pluginId, kb)));
          if (hit) {
            e.preventDefault();
            pluginHost.runCommand(pluginId, hit.command);
            return;
          }
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [currentSlide, totalSlides, onGoTo, onBlankToggle, togglePalette, keymap, pendingJump, armJump, commitJump, cancelJump, runningPlugins, pluginHost]);
}
