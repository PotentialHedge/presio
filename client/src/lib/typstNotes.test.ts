import { describe, it, expect } from "vitest";
import { typstAstToMarkdown } from "@shared/typstNotes";

// Helpers mirroring the Typst content AST shapes the `presio` package emits.
const text = (t: string) => ({ func: "text", text: t });
const seq = (...children: unknown[]) => ({ func: "sequence", children });

describe("typstAstToMarkdown", () => {
  it("renders plain text and spaces", () => {
    expect(typstAstToMarkdown(seq(text("hello"), { func: "space" }, text("world")))).toBe(
      "hello world"
    );
  });

  it("wraps strong and emph, including nested", () => {
    expect(typstAstToMarkdown({ func: "strong", body: text("bold") })).toBe("**bold**");
    expect(typstAstToMarkdown({ func: "emph", body: text("it") })).toBe("*it*");
    expect(
      typstAstToMarkdown({ func: "strong", body: { func: "emph", body: text("x") } })
    ).toBe("***x***");
  });

  it("clamps heading levels into 1..6", () => {
    expect(typstAstToMarkdown({ func: "heading", level: 2, body: text("Title") })).toBe(
      "## Title"
    );
    expect(typstAstToMarkdown({ func: "heading", level: 9, body: text("Deep") })).toBe(
      "###### Deep"
    );
    expect(typstAstToMarkdown({ func: "heading", level: 0, body: text("Zero") })).toBe(
      "# Zero"
    );
  });

  it("renders inline vs block raw", () => {
    expect(typstAstToMarkdown({ func: "raw", text: "x = 1" })).toBe("`x = 1`");
    expect(
      typstAstToMarkdown({ func: "raw", block: true, lang: "py", text: "print(1)" })
    ).toBe("```py\nprint(1)\n```");
  });

  it("renders bullet and enumerated list items", () => {
    const ast = {
      func: "list",
      children: [
        { func: "list.item", body: text("one") },
        { func: "list.item", body: text("two") },
      ],
    };
    expect(typstAstToMarkdown(ast)).toBe("- one\n- two");

    const enumed = {
      func: "enum",
      children: [{ func: "enum.item", body: text("first") }],
    };
    expect(typstAstToMarkdown(enumed)).toBe("1. first");
  });

  it("keeps apostrophes and quotes, which Typst emits as their own nodes", () => {
    // `#speaker-notes[Don't forget it's fine]`
    expect(
      typstAstToMarkdown(
        seq(
          text("Don"),
          { func: "smartquote", double: false },
          text("t forget it"),
          { func: "smartquote", double: false },
          text("s fine")
        )
      )
    ).toBe("Don't forget it's fine");

    // `#speaker-notes[Don\'t "quoted"]` — the escape produces a `symbol`.
    expect(
      typstAstToMarkdown(
        seq(
          text("Don"),
          { func: "symbol", text: "'" },
          text("t"),
          { func: "space" },
          { func: "smartquote", double: true },
          text("quoted"),
          { func: "smartquote", double: true }
        )
      )
    ).toBe('Don\'t "quoted"');
  });

  it("renders links with and without a destination", () => {
    expect(
      typstAstToMarkdown({ func: "link", dest: "https://x.com", body: text("site") })
    ).toBe("[site](https://x.com)");
    // No dest falls back to just the label text.
    expect(typstAstToMarkdown({ func: "link", body: text("plain") })).toBe("plain");
  });

  it("collapses 3+ newlines and trims", () => {
    const ast = seq(
      text("a"),
      { func: "parbreak" },
      { func: "parbreak" },
      text("b")
    );
    expect(typstAstToMarkdown(ast)).toBe("a\n\nb");
  });

  it("returns empty string for null/undefined notes", () => {
    expect(typstAstToMarkdown(null)).toBe("");
    expect(typstAstToMarkdown(undefined)).toBe("");
  });
});
