// Presio Preview: a read-only custom editor for PDFs that shows a deck the way
// Presio does — its slides with the built-in plugins' layers (media, drawings)
// and speaker notes — in a webview (client/src/embed/). This side owns the
// file: it sends the bytes, again whenever they change on disk, writes back
// what a plugin saves (edited notes), and puts the sidecar check's findings
// in the Problems panel. PDFs that are Presio decks open here even when
// another editor is the default (preferDecks.ts).

import * as path from "path";
import * as vscode from "vscode";
import { preferPresioForDecks } from "./preferDecks";
import { openInPresio } from "./openInPresio";
import type { FromWebview, PreviewIssue, SaveResult, ToWebview } from "../../client/src/embed/protocol";

const VIEW_TYPE = "presio.preview";
/** Sources a deck is commonly built from, by the PDF's side. */
const SOURCE_EXTENSIONS = [".typ", ".tex"];

export function activate(context: vscode.ExtensionContext) {
  const diagnostics = vscode.languages.createDiagnosticCollection("presio");
  const log = vscode.window.createOutputChannel("Presio Preview", { log: true });
  const provider = new PreviewProvider(context, diagnostics, log);
  context.subscriptions.push(
    log,
    diagnostics,
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      // Plugins keep playing state (a video's position, the notes being
      // edited) that a reload would lose.
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    }),
    vscode.commands.registerCommand("presio.openPreview", (uri?: vscode.Uri) => openPreview(uri, false)),
    vscode.commands.registerCommand("presio.openPreviewToSide", (uri?: vscode.Uri) => openPreview(uri, true)),
    vscode.commands.registerCommand("presio.openInPresio", (uri?: vscode.Uri) => provider.openInPresio(uri)),
    preferPresioForDecks(VIEW_TYPE)
  );
}

export function deactivate() {}

/** The file the command is about: the one it was run on, else the active one. */
function activeUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) return input.uri;
  return vscode.window.activeTextEditor?.document.uri;
}

/** Open the preview of a PDF, or of the PDF a Typst/LaTeX file builds. */
async function openPreview(uri: vscode.Uri | undefined, beside: boolean) {
  const target = uri ?? activeUri();
  if (!target) {
    void vscode.window.showInformationMessage("Open a PDF (or the Typst/LaTeX file that builds it) to preview it.");
    return;
  }
  const ext = path.extname(target.path).toLowerCase();
  const pdf = ext === ".pdf" ? target : target.with({ path: target.path.slice(0, -ext.length) + ".pdf" });
  try {
    await vscode.workspace.fs.stat(pdf);
  } catch {
    void vscode.window.showWarningMessage(`There's no ${path.basename(pdf.path)} next to ${path.basename(target.path)} yet. Build it, then open the preview again.`);
    return;
  }
  await vscode.commands.executeCommand("vscode.openWith", pdf, VIEW_TYPE, beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active);
}

/** Bytes as they come over postMessage: a Uint8Array, or (older hosts) its JSON. */
function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value && typeof value === "object") return Uint8Array.from(Object.values(value as Record<string, number>));
  throw new Error("Expected the PDF's bytes");
}

function sameBytes(a: Uint8Array | null, b: Uint8Array): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

class PreviewProvider implements vscode.CustomReadonlyEditorProvider {
  /** Open previews per file, for the diagnostics they share. */
  private open = new Map<string, number>();
  /** Open previews' panels, to ask the one in front which slide it's on. */
  private panels = new Map<vscode.WebviewPanel, vscode.Uri>();
  /** Files whose notes edits we've already warned would be lost on a rebuild. */
  private warned = new Set<string>();

  constructor(
    private context: vscode.ExtensionContext,
    private diagnostics: vscode.DiagnosticCollection,
    private log: vscode.LogOutputChannel
  ) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => {} };
  }

  resolveCustomEditor(document: vscode.CustomDocument, panel: vscode.WebviewPanel) {
    const { uri } = document;
    const key = uri.toString();
    const root = vscode.Uri.joinPath(this.context.extensionUri, "dist", "webview");
    const webview = panel.webview;
    webview.options = { enableScripts: true, localResourceRoots: [root] };
    webview.html = this.html(webview, root);
    this.open.set(key, (this.open.get(key) ?? 0) + 1);
    this.panels.set(panel, uri);

    const subscriptions: vscode.Disposable[] = [];
    const post = (message: ToWebview | SaveResult) => void webview.postMessage(message);

    // --- The deck: sent on ready, and again when the file changes ---
    let sent: Uint8Array | null = null;
    let retries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const send = async (force = false) => {
      let bytes: Uint8Array;
      try {
        bytes = await vscode.workspace.fs.readFile(uri);
      } catch {
        return; // Gone for a moment (a build replacing it): the watcher calls again.
      }
      if (!force && sameBytes(sent, bytes)) return;
      sent = bytes;
      // A copy that owns its buffer: readFile's is a view into a larger one
      // (a pooled Node Buffer), and postMessage sends the whole buffer.
      post({ type: "deck", bytes: new Uint8Array(bytes), filename: path.basename(uri.path), id: key });
    };
    // Builds write in bursts: wait for the file to settle.
    const changed = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void send(), 150);
    };
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.joinPath(uri, ".."), path.basename(uri.path))
    );
    subscriptions.push(watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed));

    // --- Messages from the webview ---
    subscriptions.push(
      webview.onDidReceiveMessage(async (message: FromWebview) => {
        switch (message.type) {
          case "ready":
            await send(true);
            break;
          case "log":
            this.log[message.level](`${path.basename(uri.path)}: ${message.message}`);
            break;
          case "loadError":
            this.log.warn(`${path.basename(uri.path)} didn't open: ${message.message}`);
            // Most likely read mid-write: try again shortly, a few times.
            if (retries++ < 3) setTimeout(() => void send(true), 500 * retries);
            break;
          case "save":
            try {
              const bytes = toBytes(message.bytes);
              sent = bytes; // Ours: the watcher's echo isn't news.
              await vscode.workspace.fs.writeFile(uri, bytes);
              post({ type: "saved", id: message.id });
              void this.warnIfBuilt(uri);
            } catch (e) {
              post({ type: "saved", id: message.id, error: e instanceof Error ? e.message : String(e) });
            }
            break;
          case "openInPresio":
            await openInPresio(this.context, uri, message.slide, this.log);
            break;
          case "report":
            retries = 0;
            this.diagnostics.set(uri, message.issues.map((issue) => toDiagnostic(issue)));
            break;
        }
      })
    );

    panel.onDidDispose(() => {
      clearTimeout(timer);
      this.panels.delete(panel);
      subscriptions.forEach((d) => d.dispose());
      const left = (this.open.get(key) ?? 1) - 1;
      if (left > 0) this.open.set(key, left);
      else {
        this.open.delete(key);
        this.diagnostics.delete(uri);
      }
    });
  }

  /**
   * The "Open in Presio" command: for the preview in front, at its slide
   * (the webview answers with the slide it's on); for a PDF picked in the
   * Explorer, or the PDF of the active Typst/LaTeX file, at the start.
   */
  async openInPresio(uri?: vscode.Uri) {
    const front = [...this.panels].find(([panel, file]) => panel.active && (!uri || file.toString() === uri.toString()));
    if (front) {
      void front[0].webview.postMessage({ type: "openInPresio" } satisfies ToWebview);
      return;
    }
    const target = uri ?? activeUri();
    if (!target) {
      void vscode.window.showInformationMessage("Open a PDF deck (or its preview) to open it in Presio.");
      return;
    }
    const ext = path.extname(target.path).toLowerCase();
    const pdf = ext === ".pdf" ? target : target.with({ path: target.path.slice(0, -ext.length) + ".pdf" });
    await openInPresio(this.context, pdf, 1, this.log);
  }

  /** Notes edited here live in the PDF; a deck built from source loses them
   *  on its next build. Say so, once per file. */
  private async warnIfBuilt(uri: vscode.Uri) {
    const key = uri.toString();
    if (this.warned.has(key)) return;
    for (const ext of SOURCE_EXTENSIONS) {
      const source = uri.with({ path: uri.path.replace(/\.pdf$/i, ext) });
      try {
        await vscode.workspace.fs.stat(source);
      } catch {
        continue;
      }
      this.warned.add(key);
      void vscode.window.showWarningMessage(
        `Saved into ${path.basename(uri.path)}. Building it again from ${path.basename(source.path)} will replace these edits, so copy them into the source to keep them.`
      );
      return;
    }
  }

  private html(webview: vscode.Webview, root: vscode.Uri): string {
    const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(root, file)).toString();
    // Plugins are trusted code (as in Presio itself, where their frames get
    // PLUGIN_FRAME_CSP), and their srcdoc frames inherit this policy: they
    // embed players (YouTube, Vimeo), run inline scripts and use blob: media.
    const csp = `default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; worker-src blob: data:`;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${asset("preview.css")}">
</head>
<body>
<div id="root"></div>
<script type="module" src="${asset("preview.js")}"></script>
</body>
</html>`;
  }
}

function toDiagnostic(issue: PreviewIssue): vscode.Diagnostic {
  const where = issue.slide !== undefined ? `Slide ${issue.slide}, ${issue.filename}` : issue.filename;
  const diagnostic = new vscode.Diagnostic(
    new vscode.Range(0, 0, 0, 0),
    `${where}: ${issue.message}`,
    issue.level === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning
  );
  diagnostic.source = "Presio";
  return diagnostic;
}
