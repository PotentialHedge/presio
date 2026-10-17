// A viewer's own off switch for each plugin the presenter runs: viewers never
// install anything, but each can turn a plugin off on their device. Off means
// its viewer surfaces aren't mounted here. Kept in this browser, per plugin id.

import { useCallback, useState } from "react";
import { lsGetString, lsRemove, lsSetString } from "@/lib/storage";

/** Whether a plugin runs anything on viewers (and so has a switch there). */
export function runsOnViewer(manifest: { surfaces: readonly string[] }): boolean {
  return manifest.surfaces.some((s) => s === "viewer" || s === "viewerSheet" || s === "slide");
}

const offKey = (pluginId: string) => `presio_viewer_plugin_off_${pluginId}`;

export interface ViewerPluginSwitches {
  isOff(pluginId: string): boolean;
  setOff(pluginId: string, off: boolean): void;
}

export function useViewerPluginSwitches(): ViewerPluginSwitches {
  // This page's switches, over what's stored: storage can be unavailable (a
  // private window), and a switch should still work until the page closes.
  const [changed, setChanged] = useState<Record<string, boolean>>({});
  const isOff = useCallback(
    (pluginId: string) => changed[pluginId] ?? lsGetString(offKey(pluginId)) === "1",
    [changed]
  );
  const setOff = useCallback((pluginId: string, off: boolean) => {
    if (off) lsSetString(offKey(pluginId), "1");
    else lsRemove(offKey(pluginId));
    setChanged((prev) => ({ ...prev, [pluginId]: off }));
  }, []);
  return { isOff, setOff };
}
