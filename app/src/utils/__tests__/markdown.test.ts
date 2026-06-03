import { stripMarkdown } from "../markdown";

describe("stripMarkdown", () => {
  it("replaces a fenced code block with the placeholder 'code block'", () => {
    // The single newlines surrounding the fence collapse to spaces (the ". "
    // paragraph rule only fires on blank lines), so the placeholder is inlined.
    expect(stripMarkdown("before\n```\nconst x = 1;\n```\nafter"))
      .toBe("before code block after");
  });

  it("drops inline code entirely", () => {
    expect(stripMarkdown("use `foo()` here")).toBe("use  here");
  });

  it("strips ATX headings", () => {
    expect(stripMarkdown("## Heading")).toBe("Heading");
  });

  it("unwraps bold and italic", () => {
    expect(stripMarkdown("**bold** and *italic*")).toBe("bold and italic");
  });

  it("renders links as their text", () => {
    expect(stripMarkdown("see [the docs](https://example.com)")).toBe("see the docs");
  });

  it("fully removes images (image rule runs before link rule)", () => {
    expect(stripMarkdown("![alt](img.png)")).toBe("");
    // image dropped entirely, surrounding text preserved
    expect(stripMarkdown("see ![diagram](d.png) here")).toBe("see  here");
    // a real link still keeps its text
    expect(stripMarkdown("a [link](u) b")).toBe("a link b");
  });

  it("turns bullets into '. ' pauses", () => {
    // Each bullet line -> ". <item>"; lines joined by single newline -> spaces.
    expect(stripMarkdown("- one\n- two")).toBe(". one . two");
  });

  it("turns a blank line (double newline) into '. '", () => {
    expect(stripMarkdown("para one\n\npara two")).toBe("para one. para two");
  });

  it("returns empty string for empty input", () => {
    expect(stripMarkdown("")).toBe("");
  });

  it("handles input that is only a code block", () => {
    expect(stripMarkdown("```\ncode\n```")).toBe("code block");
  });

  it("passes table syntax through unchanged (documented gap)", () => {
    // stripMarkdown has no table handling, so pipes/dashes survive verbatim
    // (single newlines collapse to spaces).
    const table = "| a | b |\n| - | - |\n| 1 | 2 |";
    expect(stripMarkdown(table)).toBe("| a | b | | - | - | | 1 | 2 |");
  });
});
