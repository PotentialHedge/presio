import { useState } from "react";
import type { PluginHost } from "@/lib/plugins/host";
import type { LoadedPlugin } from "@/lib/plugins/manifest";
import { cn } from "@/lib/utils";
import { PluginFrame } from "./PluginFrame";

/**
 * Viewer surfaces: each plugin gets a full-screen layer over the slide,
 * mounted (so it can listen) but hidden until the plugin asks to be shown.
 * While one is up, a label names the plugin, so the audience can see what's
 * running on their device.
 */
export function ViewerPluginLayer({ host, plugins }: { host: PluginHost; plugins: LoadedPlugin[] }) {
  return (
    <>
      {plugins
        .filter((p) => p.manifest.surfaces.includes("viewer"))
        .map((plugin) => (
          <ViewerPlugin key={plugin.hash} host={host} plugin={plugin} />
        ))}
    </>
  );
}

function ViewerPlugin({ host, plugin }: { host: PluginHost; plugin: LoadedPlugin }) {
  const [visible, setVisible] = useState(false);
  const { displayName: name, author } = plugin.manifest;
  return (
    <div className={cn("absolute inset-0 z-30", !visible && "invisible pointer-events-none")}>
      <PluginFrame host={host} plugin={plugin} surface="viewer" onVisibleChange={setVisible} className="w-full h-full" />
      {visible && (
        <span className="absolute bottom-3 left-3 rounded-full bg-black/60 px-2.5 py-1 text-[11px] text-white/60 select-none pointer-events-none">
          {name}
          {author ? ` · ${author}` : ""}
        </span>
      )}
    </div>
  );
}
