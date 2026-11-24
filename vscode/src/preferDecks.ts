// Open Presio decks in the preview: VS Code chooses an editor by file name
// alone, so the preview can't be every PDF's default. Instead, a PDF that opens
// in some other editor (a PDF viewer, or the text editor's "binary file"
// notice) and turns out to carry Presio's sidecars is swapped for the preview,
// in the same place. Off with the `presio.preview.openDecks` setting.
//
// Someone who reopens a deck with another editor on purpose (Reopen Editor
// With…, from the preview) keeps it there for the rest of the session.

import * as vscode from "vscode";
import { isPresioDeck } from "./detect";

/** A tab's file, when it's a PDF. */
function pdfOf(tab: vscode.Tab): vscode.Uri | undefined {
  const input = tab.input;
  const uri = input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom ? input.uri : undefined;
  return uri && /\.pdf$/i.test(uri.path) ? uri : undefined;
}

export function preferPresioForDecks(viewType: string): vscode.Disposable {
  const isPreview = (tab: vscode.Tab) => tab.input instanceof vscode.TabInputCustom && tab.input.viewType === viewType;
  /** Decks someone chose another editor for, by URI. */
  const declined = new Set<string>();
  /** When each deck's preview last closed, by URI: a reopen with another
   *  editor arrives as a close and an open, maybe in separate events. */
  const closedAt = new Map<string, number>();

  const enabled = () => vscode.workspace.getConfiguration("presio.preview").get<boolean>("openDecks", true);

  /** Swap a PDF tab in another editor for the preview, if it's a deck. */
  const consider = async (tab: vscode.Tab) => {
    if (isPreview(tab)) return;
    const uri = pdfOf(tab);
    if (!uri) return;
    const key = uri.toString();
    if (declined.has(key)) return;
    if (Date.now() - (closedAt.get(key) ?? 0) < 1500) {
      declined.add(key);
      return;
    }
    // Already showing as a deck somewhere: this is a second, chosen view.
    if (vscode.window.tabGroups.all.some((g) => g.tabs.some((t) => isPreview(t) && pdfOf(t)?.toString() === key))) return;

    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      return;
    }
    if (!isPresioDeck(bytes)) return;

    // The tab as it is now (the event's may be stale), if it's still open.
    const group = tab.group;
    const current = group.tabs.find((t) => !isPreview(t) && pdfOf(t)?.toString() === key);
    if (!current) return;
    // The preview first, then the other closed, so the group never empties.
    await vscode.commands.executeCommand("vscode.openWith", uri, viewType, {
      viewColumn: group.viewColumn,
      preview: current.isPreview,
      preserveFocus: !current.isActive,
    });
    await vscode.window.tabGroups.close(current, true);
  };

  // Decks open before this ran (restored with the window, or opened while
  // the extension was starting).
  if (enabled()) for (const group of vscode.window.tabGroups.all) for (const tab of group.tabs) void consider(tab);

  return vscode.window.tabGroups.onDidChangeTabs(async (e) => {
    for (const tab of e.closed) {
      const uri = isPreview(tab) ? pdfOf(tab) : undefined;
      if (uri) closedAt.set(uri.toString(), Date.now());
    }
    if (!enabled()) return;
    for (const tab of e.opened) await consider(tab);
  });
}
