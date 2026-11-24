// The webview's line to the extension.

import type { FromWebview, SaveResult, ToWebview } from "./protocol";

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

// Callable once per webview.
const api = acquireVsCodeApi();

export function post(message: FromWebview) {
  api.postMessage(message);
}

/** Bytes as they come over postMessage: a Uint8Array, or (older hosts) its JSON. */
function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return Uint8Array.from(Object.values((value ?? {}) as Record<string, number>));
}

export function onMessage(handler: (message: ToWebview | SaveResult) => void): () => void {
  const listener = (e: MessageEvent) => {
    const m = e.data as ToWebview | SaveResult;
    handler(m?.type === "deck" ? { ...m, bytes: toBytes(m.bytes) } : m);
  };
  window.addEventListener("message", listener);
  return () => window.removeEventListener("message", listener);
}

/** What survives the webview being hidden and shown again. */
export interface ViewState {
  slide?: number;
  notes?: boolean;
  thumbnails?: boolean;
  /** The panels' heights, as last dragged (CSS px). */
  notesHeight?: number;
  thumbsHeight?: number;
}

export function viewState(): ViewState {
  return (api.getState() as ViewState | undefined) ?? {};
}

export function setViewState(patch: ViewState) {
  api.setState({ ...viewState(), ...patch });
}

let nextSave = 1;
const saves = new Map<number, { resolve(): void; reject(e: Error): void }>();

window.addEventListener("message", (e: MessageEvent) => {
  const m = e.data as SaveResult;
  if (m?.type !== "saved") return;
  const pending = saves.get(m.id);
  saves.delete(m.id);
  if (!pending) return;
  if (m.error) pending.reject(new Error(m.error));
  else pending.resolve();
});

/** Write an edited deck to the file; resolves once it's on disk. */
export function saveDeck(bytes: Uint8Array): Promise<void> {
  const id = nextSave++;
  return new Promise((resolve, reject) => {
    saves.set(id, { resolve, reject });
    // A copy that owns its buffer: postMessage would send all of a view's.
    post({ type: "save", id, bytes: bytes.slice() });
  });
}
