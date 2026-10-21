import type { PDFDocumentProxy } from "pdfjs-dist";
import { generatorFromInfo, type PdfGenerator } from "@shared/pdfGenerator";

export type { PdfGenerator };

/** The tool that made this PDF (see shared/pdfGenerator). Never throws: unreadable metadata is just "unknown". */
export async function pdfGenerator(doc: PDFDocumentProxy): Promise<PdfGenerator> {
  try {
    return generatorFromInfo((await doc.getMetadata()).info);
  } catch {
    return { tool: "unknown" };
  }
}
