// Where plugin frames load the plugin runtime (public/plugin-frame.html) from.
//
// The app serves it next to itself, so frames are on this page's origin. An
// embedder that can't serve files on its own origin — the VS Code preview,
// whose webview loads resources from a separate CDN origin — hands the page's
// HTML over instead: the frame is then a srcdoc document, which shares this
// page's origin all the same.

export type FrameSource =
  | { kind: "url"; src: string }
  | { kind: "srcdoc"; html: string };

let source: FrameSource = { kind: "url", src: "/plugin-frame.html" };

/** Set once, before the first frame mounts. */
export function setFrameSource(next: FrameSource) {
  source = next;
}

export function frameSource(): FrameSource {
  return source;
}

/** The boot message's target: the frame page's origin. A srcdoc frame shares
 *  ours, which a custom scheme (vscode-webview:) may not spell as an origin,
 *  and its contents are ours, so any origin will do. */
export function frameTargetOrigin(): string {
  return source.kind === "url" ? window.location.origin : "*";
}

/** Point a frame at the runtime: on mount, and again to reload it. */
export function loadFrame(frame: HTMLIFrameElement) {
  if (source.kind === "url") frame.src = source.src;
  else frame.srcdoc = source.html;
}

/** The runtime as iframe attributes, for the first render. */
export function frameAttributes(): { src?: string; srcDoc?: string } {
  return source.kind === "url" ? { src: source.src } : { srcDoc: source.html };
}
