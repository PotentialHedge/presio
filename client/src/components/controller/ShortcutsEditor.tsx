import { useState, useEffect } from "react";
import {
  KEYMAP_ACTIONS,
  KEYMAP_LABELS,
  formatBinding,
  pluginBindings,
  pluginCommandKey,
  shortcutTakenBy,
  shiftMatters,
  type Keymap,
  type KeyBinding,
  type PluginShortcutSet,
} from "@/lib/keymap";

/** An enabled plugin's contributed keybindings, listed under its name. */
export type PluginShortcuts = PluginShortcutSet;

interface Row {
  /** The row's key in the keymap: a Presio action or "<plugin>.<command>". */
  id: string;
  label: string;
  bindings: KeyBinding[];
  plugin: boolean;
  /** Plugin rows: the plugins before this one, which win a shared key. */
  earlier?: PluginShortcuts[];
}

export function ShortcutsEditor({
  keymap,
  onChange,
  plugins = [],
}: {
  keymap: Keymap;
  onChange: (km: Keymap) => void;
  plugins?: PluginShortcuts[];
}) {
  // The row being rebound: which binding, and the row's bindings as they were.
  const [recording, setRecording] = useState<{ id: string; index: number; bindings: KeyBinding[] } | null>(null);

  const coreRows: Row[] = KEYMAP_ACTIONS.map((action) => ({
    id: action,
    label: KEYMAP_LABELS[action],
    bindings: keymap[action],
    plugin: false,
  }));
  const pluginGroups = plugins
    .filter((p) => p.keybindings.length > 0)
    .map((p, i, all) => ({
      ...p,
      rows: p.keybindings.map((kb): Row => ({
        id: pluginCommandKey(p.id, kb.command),
        label: kb.label,
        bindings: pluginBindings(keymap, p.id, kb),
        plugin: true,
        earlier: all.slice(0, i),
      })),
    }));

  useEffect(() => {
    if (!recording) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
      const binding: KeyBinding = { key: e.key };
      if (e.metaKey) binding.meta = true;
      if (e.shiftKey && shiftMatters(e.key)) binding.shift = true;
      const bindings = [...recording.bindings];
      bindings[recording.index] = binding;
      onChange({ ...keymap, [recording.id]: bindings });
      setRecording(null);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [recording, keymap, onChange]);

  const renderRow = (row: Row) => (
    <div key={row.id} className="flex items-center justify-between">
      <span className="text-sm">{row.label}</span>
      <div className="flex items-center gap-1">
        {row.bindings.map((b, i) => {
          const isRecording = recording?.id === row.id && recording.index === i;
          // Presio's own shortcuts win, then earlier plugins': a plugin key
          // one of them uses does nothing.
          const taken = row.plugin ? shortcutTakenBy(keymap, b, row.earlier ?? []) : null;
          return (
            <button
              key={i}
              type="button"
              onClick={() => setRecording({ id: row.id, index: i, bindings: row.bindings })}
              title={taken ? `Used by ${taken}, which takes precedence` : undefined}
              className={`px-2 py-1 text-xs font-mono rounded border min-w-[40px] text-center transition-colors ${isRecording
                ? "border-primary bg-primary/10 text-primary"
                : taken
                  ? "border-destructive/50 text-destructive line-through"
                  : "border-input hover:border-primary/50"
                }`}
            >
              {isRecording ? "..." : formatBinding(b)}
            </button>
          );
        })}
        {row.bindings.length < 3 && (
          <button
            type="button"
            onClick={() => {
              onChange({ ...keymap, [row.id]: [...row.bindings, { key: "" }] });
              setRecording({ id: row.id, index: row.bindings.length, bindings: row.bindings });
            }}
            className="px-1.5 py-1 text-xs rounded border border-dashed border-input hover:border-primary/50 text-muted-foreground"
          >
            +
          </button>
        )}
        {/* A plugin command may be left unbound; Presio's actions keep one key. */}
        {row.bindings.length > (row.plugin ? 0 : 1) && !recording && (
          <button
            type="button"
            onClick={() => onChange({ ...keymap, [row.id]: row.bindings.slice(0, -1) })}
            className="px-1.5 py-1 text-xs rounded border border-input hover:border-destructive text-muted-foreground hover:text-destructive"
          >
            −
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-2">
      {coreRows.map(renderRow)}
      {pluginGroups.map((group) => (
        <div key={group.id} className="space-y-2 pt-3" data-testid={`shortcuts-plugin-${group.id}`}>
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{group.name}</h4>
          {group.rows.map(renderRow)}
        </div>
      ))}
    </div>
  );
}
