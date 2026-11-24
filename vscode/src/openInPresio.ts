// "Open in Presio": hand the deck to Presio in the browser, on the slide the
// preview is showing. It goes through Presio's handoff API (POST /api/present,
// see server/routes/sessions/handoff.ts): the PDF is staged on the server just
// long enough for the browser to pull it into its own storage, where it stays
// a local presentation.
//
// The presentation each file was handed to is remembered, so opening the same
// file again replaces that presentation's deck in place (same code, same
// notes and drawings kept in the browser) rather than starting a new one each
// time the deck is rebuilt.

import * as path from "path";
import * as vscode from "vscode";

const DEFAULT_SERVER = "https://presio.xyz";

interface Handoff {
  id: string;
  token: string;
}

interface PresentReply {
  id?: string;
  url?: string;
  error?: string;
}

/** The Presio server decks are handed to (`presio.server`). */
function presioServer(): string {
  const configured = vscode.workspace.getConfiguration("presio").get<string>("server")?.trim();
  return (configured || DEFAULT_SERVER).replace(/\/+$/, "");
}

const handoffKey = (server: string, uri: vscode.Uri) => `presio.handoff:${server}:${uri.toString()}`;

async function present(server: string, bytes: Uint8Array, filename: string, update?: Handoff): Promise<{ ok: true; reply: PresentReply } | { ok: false; status: number; error: string }> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "application/pdf" }), filename);
  if (update) {
    form.append("session_id", update.id);
    form.append("controller_token", update.token);
  }
  const res = await fetch(`${server}/api/present`, { method: "POST", body: form });
  const reply = (await res.json().catch(() => ({}))) as PresentReply;
  if (!res.ok || !reply.id || !reply.url) {
    return { ok: false, status: res.status, error: reply.error || `${res.status} ${res.statusText}` };
  }
  return { ok: true, reply };
}

/** The controller token a handoff link carries (`/start/<id>?t=<token>`). */
function tokenOf(url: string): string | null {
  try {
    return new URL(url).searchParams.get("t");
  } catch {
    return null;
  }
}

/** Upload `uri` to Presio and open it in the browser at `slide`. */
export async function openInPresio(context: vscode.ExtensionContext, uri: vscode.Uri, slide: number, log: vscode.LogOutputChannel) {
  const server = presioServer();
  const filename = path.basename(uri.path);
  const key = handoffKey(server, uri);
  const host = new URL(server).host;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Opening ${filename} in Presio (${host})…` },
    async () => {
      try {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const previous = context.globalState.get<Handoff>(key);
        let result = await present(server, bytes, filename, previous);
        // The presentation it went to is gone (ended, expired, another
        // server's): start a new one.
        if (!result.ok && previous) {
          log.info(`${filename}: couldn't update presentation ${previous.id} (${result.error}); starting a new one`);
          result = await present(server, bytes, filename);
        }
        if (!result.ok) throw new Error(result.error);

        const { id, url } = result.reply as Required<Pick<PresentReply, "id" | "url">>;
        const token = tokenOf(url) ?? (previous?.id === id ? previous.token : null);
        if (token) await context.globalState.update(key, { id, token } satisfies Handoff);

        // A handoff link (a local presentation) takes the slide to open on; a
        // deck that was shared online since is opened as its controller (the
        // browser that shared it holds the token).
        const target = url.includes("/start/")
          ? `${url}${url.includes("?") ? "&" : "?"}slide=${slide}`
          : `${server}/s/${id}?role=controller`;
        await vscode.env.openExternal(vscode.Uri.parse(target, true));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log.error(`${filename}: couldn't open in Presio: ${message}`);
        void vscode.window.showErrorMessage(`Couldn't open ${filename} in Presio: ${message}`);
      }
    }
  );
}
