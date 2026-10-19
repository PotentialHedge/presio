// Convert the Typst content AST emitted by the `presio` package's
// `#speaker-notes[...]` into markdown that `marked` can render.

type Node = { func?: string; [k: string]: unknown };

function walk(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(walk).join("");
  if (typeof node !== "object") return "";
  const n = node as Node;
  const body = (n.body ?? n.child) as unknown;
  const children = n.children as unknown[] | undefined;
  switch (n.func) {
    case "text":
      return typeof n.text === "string" ? n.text : "";
    case "space":
      return " ";
    case "linebreak":
      return "  \n";
    case "parbreak":
      return "\n\n";
    case "smartquote":
      // Apostrophes and quotes reach us as their own node, with no `text`.
      return n.double ? '"' : "'";
    case "symbol":
      // Escaped punctuation (`\'`) and `#sym.*` carry the literal character.
      return typeof n.text === "string" ? n.text : "";
    case "sequence":
      return (children ?? []).map(walk).join("");
    case "strong":
      return `**${walk(body)}**`;
    case "emph":
      return `*${walk(body)}*`;
    case "link": {
      const dest = typeof n.dest === "string" ? n.dest : "";
      const label = walk(body);
      return dest ? `[${label || dest}](${dest})` : label;
    }
    case "heading": {
      const level = typeof n.level === "number" ? Math.max(1, Math.min(6, n.level)) : 1;
      return `\n${"#".repeat(level)} ${walk(body)}\n`;
    }
    case "raw": {
      const text = typeof n.text === "string" ? n.text : "";
      if (n.block) {
        const lang = typeof n.lang === "string" ? n.lang : "";
        return `\n\n\`\`\`${lang}\n${text}\n\`\`\`\n\n`;
      }
      return `\`${text}\``;
    }
    case "list.item":
      return `- ${walk(body)}\n`;
    case "enum.item":
      return `1. ${walk(body)}\n`;
    case "list":
    case "enum":
      return (children ?? []).map(walk).join("");
    default:
      if (children) return children.map(walk).join("");
      if (body !== undefined) return walk(body);
      return "";
  }
}

export function typstAstToMarkdown(node: unknown): string {
  return walk(node).replace(/\n{3,}/g, "\n\n").trim();
}

/** A notes sidecar's `notes` value — markdown, a Typst AST, or a list of
 *  either (one per note, shown separated by rules) — as markdown. */
export function notesToMarkdown(notes: unknown): string {
  if (typeof notes === "string") return notes;
  if (Array.isArray(notes)) {
    return notes
      .map((n) => typstAstToMarkdown(n))
      .filter((s) => s.length > 0)
      .join("\n\n---\n\n");
  }
  return typstAstToMarkdown(notes);
}
