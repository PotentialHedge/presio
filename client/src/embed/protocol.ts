// The VS Code preview's messages between the extension (vscode/src/) and its
// webview (this folder). The extension imports this file too, so it's types
// only.

/** One problem the sidecar check found, for the Problems panel. */
export interface PreviewIssue {
  level: "error" | "warning";
  message: string;
  /** The attachment it's about. */
  filename: string;
  /** The slide it belongs to, when it names one. */
  slide?: number;
}

/** Extension → webview. */
export type ToWebview =
  /** The PDF's bytes: on open, and whenever the file changes on disk. */
  | {
      type: "deck";
      bytes: Uint8Array;
      filename: string;
      /** Stable per file: what plugins keep their per-deck state under. */
      id: string;
    }
  /** Go to a slide (1-based). */
  | { type: "goTo"; slide: number }
  /** The "Open in Presio" command ran: answer with an openInPresio. */
  | { type: "openInPresio" };

/** Webview → extension. */
export type FromWebview =
  /** Listening: send the deck. */
  | { type: "ready" }
  /** A plugin saved an edited deck (presio.deck.save): write it to the file. */
  | { type: "save"; id: number; bytes: Uint8Array }
  /** Open this deck in Presio, at `slide` (the footer's button, or the
   *  answer to the command's request). */
  | { type: "openInPresio"; slide: number }
  /** The sidecar check of the deck now showing. */
  | { type: "report"; issues: PreviewIssue[] }
  /** The bytes didn't open as a PDF (a build still writing it, say). */
  | { type: "loadError"; message: string }
  /** Something went wrong in the webview, for the extension's log. */
  | { type: "log"; level: "error" | "warn"; message: string };

/** The extension's answer to a "save". */
export type SaveResult = { type: "saved"; id: number; error?: string };
