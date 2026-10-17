// Typed, failure-tolerant wrappers around localStorage.
//
// Every read/write is guarded: private/incognito windows throw on access, and a
// corrupt value should never crash the UI. JSON helpers fall back to a default;
// string helpers fall back to a provided default. This replaces the
// hand-rolled `try { JSON.parse(localStorage.getItem(...)) } catch {}` dance
// that was duplicated across the app.

/** Static localStorage keys. Per-session keys (plugin state, session auth) are built
 *  from an id, so they're kept as factory functions rather than constants. */
export const STORAGE_KEYS = {
  // The user's settings document (lib/settings.ts). Preferences live there;
  // the keys below are app state.
  settings: "presio_settings",
  // Mosaic binary-tree layout for the controller dashboard. A card is "visible"
  // iff it appears as a leaf in the tree, so visibility no longer needs its own
  // key (replaces the legacy controllerLayout/controllerCards array format).
  controllerMosaic: "presio_controller_mosaic",
  // The same dashboard, arranged for a phone. Kept apart from the desktop tree
  // so rearranging cards on one form factor never rewrites the other.
  controllerMosaicMobile: "presio_controller_mosaic_mobile",
  controllerMosaicMobileLandscape: "presio_controller_mosaic_mobile_landscape",
  preferredMosaic: "presio_preferred_mosaic",
  controllerOnboarded: "presio_controller_onboarded",
  // Whether the mobile "best on desktop" notice has been dismissed.
  mobileNoticeSeen: "presio_mobile_notice_seen",
  // Whether the add-to-home-screen prompt has been seen/actioned. Shown on
  // touch devices while presenting, never on the landing page.
  installPromptSeen: "presio_install_prompt_seen",
  // Email list prompt: "subscribed" | "dismissed" (absent = not asked yet).
  newsletterStatus: "presio_newsletter_status",
  // Test hook: override the prompt delay (ms).
  newsletterDelayOverride: "presio_newsletter_delay_ms",
} as const;

/** Plugins' presio.storage for one session: { [pluginId]: { [key]: value } }. */
export const pluginStateKey = (id: string) => `presio_plugin_state_${id}`;
/** The presenter's retained plugin messages for one session (lib/plugins/host.ts). */
export const pluginRetainedKey = (id: string) => `presio_plugin_retained_${id}`;
/** The presenter's copy of viewers' input to plugins for one session (presio.audience). */
export const pluginAudienceKey = (id: string) => `presio_plugin_audience_${id}`;
/** This browser's anonymous viewer id for one session (presio.audience). */
export const audienceViewerKey = (id: string) => `presio_audience_viewer_${id}`;
export const sessionKey = (id: string) => `session_${id}`;
/** Live-reload preference for a local deck: "off" | "prompt" | "auto". A device
 *  preference (the file being watched is on this machine), not session state. */
export const deckWatchKey = (id: string) => `presio_deck_watch_${id}`;
/** Set once the "Open viewer" prompt is answered for a deck (opened or dismissed). */
export const viewerOpenedKey = (id: string) => `presio_viewer_opened_${id}`;
/** The slide a local deck's controller is on, so a reload stays there. (A
 *  synced deck's is on the server.) */
export const slideKey = (id: string) => `presio_slide_${id}`;

/** Read and JSON-parse a value, returning `fallback` if absent or malformed. */
export function lsGet<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/** JSON-stringify and store a value. Swallows storage errors. */
export function lsSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable (private mode) — ignore */
  }
}

/** Read a raw string value, returning `fallback` if absent or unavailable. */
export function lsGetString(key: string, fallback = ""): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Store a raw string value. Swallows storage errors. */
export function lsSetString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

/** Remove a key. Swallows storage errors. */
export function lsRemove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/** Move a deck's per-session state from one id to another. Sharing a local deck
 *  mints its real join code server-side, so the deck is re-keyed — and anything
 *  stored under the old id would be silently lost at exactly the moment the
 *  presenter shares. Plugins' retained state is the one that hurts (it holds
 *  the drawings); their storage and the viewer-opened flag are moved for the
 *  same reason (a running timer resetting, or the "open the viewer" prompt
 *  reappearing, mid-presentation). */
export function rekeySessionStorage(oldId: string, newId: string): void {
  if (oldId === newId) return;
  for (const key of [pluginRetainedKey, pluginStateKey, pluginAudienceKey, viewerOpenedKey]) {
    const value = lsGetString(key(oldId), "");
    if (value) lsSetString(key(newId), value);
    lsRemove(key(oldId));
  }
}
