import { parseDiff, diffCounts, showLeadingWhitespace } from "../diff";

describe("parseDiff", () => {
  it("classifies + / - / context / separators", () => {
    const rows = parseDiff("- old one\n- old two\n+ new one\n@@ edit 2 of 3 @@\n  context");
    expect(rows.map((r) => r.kind)).toEqual(["del", "del", "add", "sep", "ctx"]);
    expect(rows[0].text).toBe("old one");   // "- " prefix stripped
    expect(rows[2].text).toBe("new one");   // "+ " prefix stripped
    expect(rows[3].text).toBe("@@ edit 2 of 3 @@");
    expect(rows[4].text).toBe("  context"); // context indentation preserved
  });

  it("preserves interior content and blank lines", () => {
    const rows = parseDiff("+ a = b + c\n+ \n- gone");
    expect(rows[0]).toEqual({ kind: "add", text: "a = b + c" }); // interior '+' kept
    expect(rows[1]).toEqual({ kind: "add", text: "" });          // blank added line
    expect(rows[2]).toEqual({ kind: "del", text: "gone" });
  });

  it("treats the '… +N more edits' footer as a separator", () => {
    expect(parseDiff("… +3 more edits")[0].kind).toBe("sep");
  });
});

describe("diffCounts", () => {
  it("counts add/del rows only", () => {
    const rows = parseDiff("- a\n- b\n+ c\n@@ x @@\n  ctx");
    expect(diffCounts(rows)).toEqual({ added: 1, removed: 2 });
  });
});

describe("showLeadingWhitespace", () => {
  it("dots only the leading run, leaving interior spacing intact", () => {
    expect(showLeadingWhitespace("    return x")).toBe("····return x");
    expect(showLeadingWhitespace("no indent here")).toBe("no indent here");
    expect(showLeadingWhitespace("  a  b")).toBe("··a  b"); // interior kept
  });
  it("expands a leading tab to two dots", () => {
    expect(showLeadingWhitespace("\tx")).toBe("··x");
  });
});
