// The VS Code preview's webview (src/embed/), built into the extension:
// vscode/dist/webview/preview.{js,css}. One script and one stylesheet with
// everything inlined — the webview serves them from a CDN origin of its own,
// so no other file of ours could be fetched or run from there. Run by
// `npm run build:vscode`, or the extension's own build.
import path from "path"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { standaloneBuiltinPlugins } from "./plugins/build"

export default defineConfig({
  plugins: [react(), standaloneBuiltinPlugins()],
  // No .env: the webview never talks to a Presio server. Nor the app's
  // public files: the one it uses, plugin-frame.html, is imported.
  envDir: false,
  publicDir: false,
  build: {
    outDir: path.resolve(__dirname, "../vscode/dist/webview"),
    emptyOutDir: true,
    // Electron's Chromium, at least as new as VS Code's oldest supported.
    target: "chrome120",
    cssCodeSplit: false,
    assetsInlineLimit: () => true,
    modulePreload: false,
    rollupOptions: {
      input: path.resolve(__dirname, "src/embed/main.tsx"),
      output: {
        codeSplitting: false,
        format: "es",
        entryFileNames: "preview.js",
        assetFileNames: "preview[extname]",
      },
    },
  },
  worker: { format: "iife" },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@shared": path.resolve(__dirname, "../shared"),
    },
  },
})
