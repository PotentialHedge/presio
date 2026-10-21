// Which tool made a PDF, read from its document info (Creator / Producer) so
// analytics can tell Typst decks from Beamer, PowerPoint, Keynote and the
// rest — in the browser on import and on the server for POST /api/present.
// Only these two software strings are read — never Title, Author or
// anything else a presenter typed in.

export interface PdfGenerator {
  /** A coarse label for grouping, e.g. "typst", "beamer", "powerpoint". */
  tool: string;
  /** The raw strings, trimmed and capped, for spotting tools not yet classified. */
  creator?: string;
  producer?: string;
}

// Checked in order against "creator | producer", lowercased. Creator names the
// authoring app and goes first; Producer is often just the PDF backend (pdfTeX,
// Quartz, Skia), so the generic engines sit at the end as fallbacks.
const TOOLS: [string, RegExp][] = [
  ["typst", /\btypst\b/],
  ["beamer", /beamer/],
  ["marp", /\bmarp\b/],
  ["slidev", /slidev/],
  ["quarto", /quarto/],
  ["decktape", /decktape/],
  ["powerpoint", /powerpoint/],
  ["keynote", /keynote/],
  ["google-slides", /google (docs|slides)/],
  ["canva", /\bcanva\b/],
  ["figma", /\bfigma\b/],
  ["pitch", /\bpitch\b/],
  ["libreoffice", /libreoffice|openoffice|\bimpress\b/],
  ["word", /microsoft.{0,3} word/],
  ["affinity", /affinity/],
  ["illustrator", /illustrator/],
  ["indesign", /indesign/],
  ["latex", /latex|pdftex|xetex|luatex|luahbtex|xdvipdfmx|dvipdfm|tex live|miktex/],
  ["chromium", /skia\/pdf|chromium|headlesschrome/],
  ["quartz", /quartz pdfcontext|mac os x|macos/],
  ["ghostscript", /ghostscript/],
  ["acrobat", /acrobat|adobe pdf library|distiller/],
];

function clean(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const s = value.replace(/\s+/g, " ").trim();
  return s ? s.slice(0, 80) : undefined;
}

export function classifyGenerator(creator?: string, producer?: string): string {
  const both = `${creator ?? ""} | ${producer ?? ""}`.toLowerCase();
  for (const [tool, re] of TOOLS) if (re.test(both)) return tool;
  return creator || producer ? "other" : "unknown";
}

/** From pdf.js's `getMetadata().info`, whatever shape it came back in. */
export function generatorFromInfo(info: unknown): PdfGenerator {
  const { Creator, Producer } = (info ?? {}) as Record<string, unknown>;
  const creator = clean(Creator);
  const producer = clean(Producer);
  return { tool: classifyGenerator(creator, producer), creator, producer };
}
