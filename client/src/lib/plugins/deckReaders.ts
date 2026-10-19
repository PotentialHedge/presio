// What plugins read of the deck (presio.deck), each read once per document.

import { useMemo } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { readAttachments, attachmentNames, type PdfAttachment } from "@/lib/pdf";
import type { PageSize } from "./host";

/** The deck's attachments, read once per document. */
export function useAttachmentReader(pdf: PDFDocumentProxy | null) {
  return useMemo(() => {
    let cached: Promise<PdfAttachment[]> | null = null;
    return () => {
      if (!pdf) return Promise.resolve([]);
      return (cached ??= readAttachments(pdf).catch(() => []));
    };
  }, [pdf]);
}

/** The deck's PDF bytes, for plugins that read the file themselves. */
export function useBytesReader(pdf: PDFDocumentProxy | null) {
  return useMemo(() => async () => (pdf ? pdf.getData() : null), [pdf]);
}

/** The deck's attachment filenames, without reading their bytes. */
export function useAttachmentNamesReader(pdf: PDFDocumentProxy | null) {
  return useMemo(() => {
    let cached: Promise<string[]> | null = null;
    return () => {
      if (!pdf) return Promise.resolve([]);
      return (cached ??= attachmentNames(pdf).catch(() => []));
    };
  }, [pdf]);
}

/** Each page's size in PDF points, read once per document. */
export function usePagesReader(pdf: PDFDocumentProxy | null) {
  return useMemo(() => {
    let cached: Promise<PageSize[]> | null = null;
    return () => {
      if (!pdf) return Promise.resolve([]);
      return (cached ??= (async () => {
        const sizes: PageSize[] = [];
        for (let n = 1; n <= pdf.numPages; n++) {
          const [x1, y1, x2, y2] = (await pdf.getPage(n)).view;
          sizes.push({ width: x2 - x1, height: y2 - y1 });
        }
        return sizes;
      })());
    };
  }, [pdf]);
}
