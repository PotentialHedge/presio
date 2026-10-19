import { useState } from "react";
import { stripAttachments } from "@/lib/stripAttachments";
import type { Deck } from "@/lib/deck";
import type { PluginHost } from "@/lib/plugins/host";
import { saveFile } from "@/lib/saveFile";

export type DownloadMode = "everything" | "original" | "no-attachments";

// Shared download logic: assembles the requested PDF variant from the deck
// and hands it to the browser. Used by DownloadButton's split button and by the
// narrow-footer overflow menu. Lives here rather than beside the component so
// the component file only exports components (react-refresh).
//
// Order matters: plugins' export handlers (presio.deck.onExport) see the deck
// as it is, attachments and all — they may read what they bake in from them —
// then attachments are stripped.
export function useDeckDownload(deck: Deck, plugins?: PluginHost) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stem = (deck.filename || "slides").replace(/\.pdf$/i, "");

  const download = async (mode: DownloadMode) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      let bytes = await deck.pdf.getData();
      let name = `${stem}.pdf`;
      // "original" is the file as it was loaded, untouched by plugins.
      if (plugins && mode !== "original") bytes = await plugins.exportDeck(bytes, mode);
      if (mode === "no-attachments" && deck.hasAttachments) {
        bytes = await stripAttachments(bytes);
        name = `${stem}-no-attachments.pdf`;
      }
      saveFile(new Blob([bytes.slice()], { type: "application/pdf" }), name);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed");
    } finally {
      setBusy(false);
    }
  };

  return { busy, error, download };
}
