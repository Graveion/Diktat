import {
  detectSlashCommand,
  buildContextualStrings,
  CODING_VOCAB_BASE,
} from "../voice";

describe("detectSlashCommand", () => {
  it("maps an exact phrase: 'plan mode' -> /plan", () => {
    expect(detectSlashCommand("plan mode")).toBe("/plan");
  });

  it("maps a prefixed phrase: 'compress context now' -> /compress", () => {
    expect(detectSlashCommand("compress context now")).toBe("/compress");
  });

  it("returns non-matching text verbatim with case preserved", () => {
    expect(detectSlashCommand("Fix the Bug")).toBe("Fix the Bug");
  });

  it("does not match a pattern that appears mid-string", () => {
    expect(detectSlashCommand("please switch to plan tomorrow")).toBe(
      "please switch to plan tomorrow",
    );
  });
});

describe("buildContextualStrings", () => {
  it("with no arg returns the base list unchanged in length", () => {
    expect(buildContextualStrings()).toHaveLength(CODING_VOCAB_BASE.length);
  });

  it("appends a provided label", () => {
    const result = buildContextualStrings("MyProject");
    expect(result).toHaveLength(CODING_VOCAB_BASE.length + 1);
    expect(result[result.length - 1]).toBe("MyProject");
  });

  it("does not push an empty-string label", () => {
    expect(buildContextualStrings("")).toHaveLength(CODING_VOCAB_BASE.length);
  });
});
