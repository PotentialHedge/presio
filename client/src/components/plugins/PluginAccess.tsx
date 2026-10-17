import { useState, type ReactNode } from "react";
import { ChevronRight, ShieldCheck, Users } from "lucide-react";
import type { ButtonLocation, PluginManifest, PluginPermission, PluginSurface } from "@/lib/plugins/manifest";
import { AUDIENCE_SURFACES, PERMISSIONS } from "@/lib/plugins/access";

// What a plugin may do and where it shows up, short: one line per permission
// (its detail a click away) and the places it adds things to behind a toggle.
// The trust prompt and each plugin's Settings page both show it.

const SURFACES: Record<PluginSurface, string> = {
  background: "Runs in the background on this device while you present",
  panel: "A card on your dashboard",
  viewerSheet: "A panel on your audience's phones and screens",
  viewer: "A full-screen layer on every viewer's screen",
  slide: "Draws over your slides, on your screen and every viewer's",
};

const BUTTONS: Record<ButtonLocation, string> = {
  "controller.toolbar": "A button in your bottom bar",
  "controller.currentSlide": "A button in the current slide's header",
  "thumbnail.context": "An item in the thumbnails' menu",
  "viewer.toolbar": "A button on your audience's toolbar",
  settings: "Actions on its Settings page",
};

export const NewBadge = () => (
  <span className="rounded bg-amber-500/15 px-1 py-px text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">New</span>
);

export function PluginAccess({
  manifest,
  newPermissions = [],
  shortcuts,
  showPlaces = false,
}: {
  manifest: PluginManifest;
  /** Permissions it didn't have when last allowed, marked as new. */
  newPermissions?: PluginPermission[];
  /** Its keyboard shortcuts, spelled out by the caller; by default one line says it has some. */
  shortcuts?: ReactNode;
  /** Start with where it shows up open. */
  showPlaces?: boolean;
}) {
  const [placesOpen, setPlacesOpen] = useState(showPlaces);
  const audience = manifest.surfaces.some((s) => AUDIENCE_SURFACES.includes(s));
  const labels = new Map<ButtonLocation, string[]>();
  for (const b of manifest.contributes.buttons) {
    const label = b.label ?? manifest.contributes.commands.find((c) => c.id === b.command)?.title ?? b.command;
    labels.set(b.location, [...(labels.get(b.location) ?? []), label]);
  }
  const hasShortcuts = manifest.contributes.keybindings.length > 0;

  return (
    <div className="space-y-2" data-testid="plugin-access">
      <ul className="space-y-1" data-testid="plugin-prompt-permissions">
        {manifest.permissions.map((p) => (
          <Permission key={p} permission={p} isNew={newPermissions.includes(p)} />
        ))}
        {audience && (
          <li className="flex items-center gap-2 text-sm" data-testid="plugin-prompt-audience">
            <Users className="size-4 shrink-0 text-primary" /> Runs on your audience's devices
          </li>
        )}
        {!manifest.permissions.length && !audience && (
          <li className="flex items-center gap-2 text-sm text-muted-foreground">
            <ShieldCheck className="size-4 shrink-0" /> No special permissions
          </li>
        )}
      </ul>

      <button
        type="button"
        onClick={() => setPlacesOpen((o) => !o)}
        aria-expanded={placesOpen}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={`size-3.5 transition-transform ${placesOpen ? "rotate-90" : ""}`} />
        Where it shows up
      </button>
      {placesOpen && (
        <ul className="list-disc space-y-0.5 pl-9 text-xs text-muted-foreground">
          {manifest.surfaces.map((s) => <li key={s}>{SURFACES[s]}</li>)}
          {[...labels].map(([location, names]) => (
            <li key={location}>
              {BUTTONS[location]}: {names.map((n) => `“${n}”`).join(", ")}
            </li>
          ))}
          {hasShortcuts && (shortcuts ?? <li>Keyboard shortcuts</li>)}
        </ul>
      )}
    </div>
  );
}

function Permission({ permission, isNew }: { permission: PluginPermission; isNew: boolean }) {
  const [open, setOpen] = useState(false);
  const { title, detail } = PERMISSIONS[permission];
  return (
    <li className={isNew ? "-mx-2 rounded-md bg-amber-500/10 px-2 py-0.5" : ""}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-left text-sm text-amber-700 dark:text-amber-400"
      >
        <ChevronRight className={`size-4 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        {title} {isNew && <NewBadge />}
      </button>
      {open && <p className="pl-6 text-xs text-muted-foreground">{detail}</p>}
    </li>
  );
}
