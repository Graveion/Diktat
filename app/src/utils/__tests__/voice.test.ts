import {
  matchVoiceCommand,
  detectSlashCommand,
  adaptiveCountdownMultiplier,
  buildContextualStrings,
  CODING_VOCAB_BASE,
} from "../voice";

describe("matchVoiceCommand", () => {
  it("returns null for more than 4 words", () => {
    expect(matchVoiceCommand("one two three four five")).toBeNull();
  });

  it("strips trailing punctuation: 'send.' / 'send!' -> 'send'", () => {
    expect(matchVoiceCommand("send.")).toBe("send");
    expect(matchVoiceCommand("send!")).toBe("send");
  });

  it("recognises all send variants", () => {
    for (const phrase of ["send", "send it", "yes send", "okay send it", "submit", "go"]) {
      expect(matchVoiceCommand(phrase)).toBe("send");
    }
  });

  it("recognises the cancel set", () => {
    for (const phrase of [
      "cancel", "discard", "scrap", "nevermind", "never mind",
      "no wait", "delete that", "nope", "stop",
    ]) {
      expect(matchVoiceCommand(phrase)).toBe("cancel");
    }
  });

  it("recognises the edit set", () => {
    for (const phrase of ["edit", "edit it", "let me edit", "let me fix that", "let me fix it"]) {
      expect(matchVoiceCommand(phrase)).toBe("edit");
    }
  });

  it("recognises the plan set", () => {
    for (const phrase of ["plan", "slash plan", "make a plan"]) {
      expect(matchVoiceCommand(phrase)).toBe("plan");
    }
  });

  it("normalises case and surrounding whitespace", () => {
    expect(matchVoiceCommand("  SEND  ")).toBe("send");
  });

  it("returns null for non-command speech", () => {
    expect(matchVoiceCommand("hello there")).toBeNull();
  });
});

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

describe("adaptiveCountdownMultiplier", () => {
  it("empty string -> 0", () => {
    expect(adaptiveCountdownMultiplier("")).toBe(0);
  });

  it("hesitation markers -> 0", () => {
    expect(adaptiveCountdownMultiplier("um let me think about this")).toBe(0);
    expect(adaptiveCountdownMultiplier("wait no")).toBe(0);
    expect(adaptiveCountdownMultiplier("actually do something else")).toBe(0);
  });

  it("single word -> 0", () => {
    expect(adaptiveCountdownMultiplier("hello")).toBe(0);
  });

  it("ends with '?' -> 1.5", () => {
    expect(adaptiveCountdownMultiplier("can you do this thing?")).toBe(1.5);
  });

  it("more than 30 words -> 1.4 (boundary 30 vs 31)", () => {
    const thirtyWords = Array(30).fill("word").join(" ");
    const thirtyOneWords = Array(31).fill("word").join(" ");
    // 30 words is NOT > 30, falls through to normal (1.0)
    expect(adaptiveCountdownMultiplier(thirtyWords)).toBe(1.0);
    expect(adaptiveCountdownMultiplier(thirtyOneWords)).toBe(1.4);
  });

  it("fewer than 5 words -> 0.7 (boundary at 5)", () => {
    // 4 words (>1, <5) -> 0.7
    expect(adaptiveCountdownMultiplier("two three four five")).toBe(0.7);
    // 5 words -> not < 5, normal (1.0)
    expect(adaptiveCountdownMultiplier("one two three four five")).toBe(1.0);
  });

  it("normal utterance -> 1.0", () => {
    expect(adaptiveCountdownMultiplier("this is a normal sentence here")).toBe(1.0);
  });

  it("precedence: a long question is treated as a question (1.5)", () => {
    const longQuestion = Array(40).fill("word").join(" ") + "?";
    expect(adaptiveCountdownMultiplier(longQuestion)).toBe(1.5);
  });

  it("precedence: a single-word question is suppressed (0)", () => {
    expect(adaptiveCountdownMultiplier("why?")).toBe(0);
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
