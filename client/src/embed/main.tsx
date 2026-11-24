// Entry of the VS Code preview's webview (built by vite.vscode.config.ts into
// vscode/dist/webview/). Everything it runs is in its own bundle: the plugin
// runtime is a srcdoc frame, the built-in plugins are inlined HTML and the
// pdf.js worker starts from a blob — a webview's own files are served from
// another origin, which frames and workers can't run from as the app's do.

import "../polyfills";
import "./preview.css";
import { createRoot } from "react-dom/client";
import frameHtml from "../../public/plugin-frame.html?raw";
import PdfWorker from "@/lib/pdfWorker.ts?worker&inline";
import { setFrameSource } from "@/lib/plugins/frameSource";
import { setPdfWorkerFactory } from "@/lib/pdf";
import { PreviewApp } from "./PreviewApp";
import { post } from "./vscode";

// A webview's console is out of sight (Developer Tools): send what breaks to
// the extension's log as well.
window.addEventListener("error", (e) => post({ type: "log", level: "error", message: e.message }));
window.addEventListener("unhandledrejection", (e) => post({ type: "log", level: "error", message: String(e.reason?.stack ?? e.reason) }));

setFrameSource({ kind: "srcdoc", html: frameHtml });
setPdfWorkerFactory(() => new PdfWorker());

// Follow VS Code's theme: it marks <body>; Presio (and its plugins) read
// `dark` on <html>.
const syncTheme = () => {
  const body = document.body.classList;
  const dark = body.contains("vscode-dark") || (body.contains("vscode-high-contrast") && !body.contains("vscode-high-contrast-light"));
  document.documentElement.classList.toggle("dark", dark);
};
syncTheme();
new MutationObserver(syncTheme).observe(document.body, { attributes: true, attributeFilter: ["class"] });

createRoot(document.getElementById("root")!).render(<PreviewApp />);
