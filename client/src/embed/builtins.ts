// The built-in plugins the preview runs, from the standalone build
// (standaloneBuiltinPlugins in client/plugins/build.ts): each one's HTML is
// self-contained, so a frame needs nothing fetched to run it.

import builtins from "virtual:presio-builtin-plugins";
import { sha256Hex } from "@/lib/analytics";
import { builtinUrl } from "@/lib/plugins/resolve";
import { isActivatedBy, validateManifest, type LoadedPlugin } from "@/lib/plugins/manifest";
import { pluginIdOf } from "@shared/plugin/sources";

/**
 * What a preview shows of a deck: its media, its notes and the drawings saved
 * in it. Not the timer or the join code, which are about a running talk.
 * Ordered as BUILTINS orders them (resolve.ts), which is how layers stack.
 */
export const PREVIEW_PLUGINS = ["notes", "media", "drawing"];

let loaded: Promise<LoadedPlugin[]> | null = null;

function loadBuiltins(): Promise<LoadedPlugin[]> {
  loaded ??= Promise.all(
    PREVIEW_PLUGINS.flatMap((name) => {
      const built = builtins.find((b) => b.name === name);
      if (!built) return [];
      const { manifest, errors } = validateManifest(built.manifest);
      if (!manifest) {
        console.error(`Presio: the built-in "${name}" plugin's manifest isn't valid`, errors);
        return [];
      }
      return [
        (async (): Promise<LoadedPlugin> => ({
          id: pluginIdOf({ kind: "builtin", name }, manifest.name),
          key: builtinUrl(name),
          manifest,
          url: builtinUrl(name),
          // Nothing to resolve against: the HTML carries everything.
          baseUrl: "",
          html: built.html,
          hash: await sha256Hex(new TextEncoder().encode(built.html).buffer as ArrayBuffer),
        }))(),
      ];
    })
  );
  return loaded;
}

/** The built-ins a deck with these attachments activates. */
export async function pluginsFor(attachmentNames: readonly string[]): Promise<LoadedPlugin[]> {
  return (await loadBuiltins()).filter((p) => isActivatedBy(p.manifest, attachmentNames));
}
