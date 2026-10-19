import { MAX_PDF_BYTES } from "@shared/limits";

// Largest PDF the server accepts on an upload (sync, claim, re-upload).
export { MAX_PDF_BYTES };

export const MAX_PDF_MB = MAX_PDF_BYTES / 1024 / 1024;
