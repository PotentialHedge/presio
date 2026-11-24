// A PluginHost for the preview: the presenter of a deck nobody else is
// watching. No session, no transport, no plugin registry — the built-ins the
// deck activates run with this webview's settings (their defaults at first).

import { useEffect, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { PluginHost, type PluginContext } from "@/lib/plugins/host";
import type { LoadedPlugin } from "@/lib/plugins/manifest";
import type { PluginHostState } from "@/lib/plugins/usePluginHost";
import { useAttachmentNamesReader, useAttachmentReader, useBytesReader, usePagesReader } from "@/lib/plugins/deckReaders";
import { resolvePluginSettings, useSettingsDocument } from "@/lib/settings";
import { useResolvedTheme } from "@/hooks/useResolvedTheme";
import { pluginsFor } from "./builtins";

export function usePreviewHost({
  sessionId,
  pdf,
  currentSlide,
  totalSlides,
  save,
}: {
  /** What plugins' per-deck state is kept under: one per file. */
  sessionId: string;
  pdf: PDFDocumentProxy | null;
  currentSlide: number;
  totalSlides: number;
  /** Write an edited deck (presio.deck.save). */
  save: (bytes: Uint8Array) => Promise<void>;
}): PluginHostState {
  const theme = useResolvedTheme();
  const ctx: PluginContext = {
    role: "presenter",
    theme,
    session: { id: sessionId, local: true, joinUrl: null },
    slide: { current: currentSlide, total: totalSlides },
  };
  const [host] = useState(() => new PluginHost(ctx));
  useEffect(() => {
    host.attach();
    return () => host.dispose();
  }, [host]);
  useEffect(() => {
    host.updateContext(ctx);
  });

  const readAll = useAttachmentReader(pdf);
  const readBytes = useBytesReader(pdf);
  const readPages = usePagesReader(pdf);
  const readNames = useAttachmentNamesReader(pdf);
  useEffect(() => {
    if (pdf) host.setDeckSource(readAll, readBytes, readPages);
  }, [host, pdf, readAll, readBytes, readPages]);
  useEffect(() => host.setDeckWriter(save), [host, save]);

  // The plugins this deck activates. Ones that stay keep their objects, so
  // their frames aren't remounted by a reload of the file.
  const [plugins, setPlugins] = useState<LoadedPlugin[]>([]);
  useEffect(() => {
    if (!pdf) return;
    let cancelled = false;
    (async () => {
      const next = await pluginsFor(await readNames());
      if (cancelled) return;
      setPlugins((prev) => {
        const kept = next.map((p) => prev.find((q) => q.hash === p.hash) ?? p);
        return kept.length === prev.length && kept.every((p, i) => p === prev[i]) ? prev : kept;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [pdf, readNames]);

  const runningIds = plugins.map((p) => p.id).join(",");
  useEffect(() => host.setRunning(runningIds ? runningIds.split(",") : []), [host, runningIds]);

  // Plugins' settings, and again whenever one changes: a plugin setting its
  // own (the drawing palette's toggle, the notes' size) hears it back.
  const settingsDoc = useSettingsDocument();
  useEffect(() => {
    for (const { id, manifest } of plugins) host.setPluginSettings(id, resolvePluginSettings(id, manifest.contributes.settings, settingsDoc));
  }, [host, plugins, settingsDoc]);

  return { host, plugins, errors: {}, viewerErrors: {} };
}
