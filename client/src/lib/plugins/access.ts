// What each permission lets a plugin do, in words, and which surfaces put it
// on audience devices: for the trust prompt and Settings
// (components/plugins/PluginAccess.tsx).

import type { PluginPermission, PluginSurface } from "./manifest";

export const PERMISSIONS: Record<PluginPermission, { title: string; detail: string }> = {
  deck: { title: "Read your deck", detail: "Its pages, its attachments and the PDF file itself." },
  editDeck: { title: "Change your deck", detail: "Save an edited PDF over the one you're presenting." },
  history: { title: "Keep an edit history", detail: "Shared with every screen in the session, with any files it adds." },
  audience: { title: "Collect input from your audience", detail: "What each viewer sends, under an anonymous id." },
  screen: { title: "Share a screen", detail: "Capture a screen, window or tab, once you pick one in your browser's prompt." },
  camera: { title: "Use the camera", detail: "Your browser still asks before it turns the camera on." },
  microphone: { title: "Use the microphone", detail: "Your browser still asks before it turns the microphone on." },
};

/** Surfaces that run on audience devices. */
export const AUDIENCE_SURFACES: PluginSurface[] = ["viewer", "viewerSheet", "slide"];
