// How a setting is declared and checked: by Presio for its own settings
// (client/src/lib/settings.ts) and by plugins in their manifest's
// contributes.settings. Shared so the manifest validator can check a
// plugin's defaults against their own specs.

export type SettingSpec =
  | { type: "boolean"; default: boolean; description?: string }
  | { type: "number"; default: number | null; minimum?: number; maximum?: number; description?: string }
  | { type: "string"; default: string; maxLength?: number; description?: string }
  | { type: "enum"; default: string; values: string[]; labels?: string[]; description?: string }
  | { type: "object"; default: unknown; description?: string };

/** A setting a plugin declares (plugins may not declare "object" ones). */
export type PluginSettingSpec = Exclude<SettingSpec, { type: "object" }>;

/** Coerce a stored value to a spec, or undefined when it doesn't fit. */
export function sanitizeSettingValue(spec: SettingSpec, raw: unknown): unknown {
  switch (spec.type) {
    case "boolean":
      return typeof raw === "boolean" ? raw : undefined;
    case "number":
      if (raw === null && spec.default === null) return null;
      if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
      if (spec.minimum !== undefined && raw < spec.minimum) return undefined;
      if (spec.maximum !== undefined && raw > spec.maximum) return undefined;
      return raw;
    case "string":
      if (typeof raw !== "string") return undefined;
      return raw.length <= (spec.maxLength ?? 1000) ? raw : undefined;
    case "enum":
      return typeof raw === "string" && spec.values.includes(raw) ? raw : undefined;
    case "object":
      return raw;
  }
}
