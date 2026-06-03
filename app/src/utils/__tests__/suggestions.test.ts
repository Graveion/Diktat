import { suggestCommands, buildIdleSuggestions } from "../suggestions";

const ALL = ["/plan", "/ask", "/clear", "/new-chat", "/compact", "/compress"];

describe("suggestCommands", () => {
  it("returns [] for empty text", () => {
    expect(suggestCommands("", ALL)).toEqual([]);
  });

  it("returns [] when text already starts with a slash", () => {
    expect(suggestCommands("/plan something", ALL)).toEqual([]);
  });

  it("suggests /plan for a planning phrase when /plan is available", () => {
    expect(suggestCommands("plan the refactor", ["/plan", "/ask"])).toEqual(["/plan"]);
  });

  it("suggests /ask for an exploratory phrase", () => {
    expect(suggestCommands("how does this work", ALL)).toEqual(["/ask"]);
  });

  it("excludes commands not in the available list", () => {
    // 'plan the refactor' matches /plan, but /plan is not available here.
    expect(suggestCommands("plan the refactor", ["/ask"])).toEqual([]);
  });

  it("caps at 2 even when 3+ rules match", () => {
    // 'plan' -> /plan, 'explain' -> /ask, 'reset' -> /clear (3 rules).
    const result = suggestCommands("plan and explain then reset", ALL);
    expect(result).toHaveLength(2);
    expect(result).toEqual(["/plan", "/ask"]);
  });

  it("dedupes a command matched by multiple phrases", () => {
    // Two /plan triggers ('plan' and 'design') still yield a single /plan.
    expect(suggestCommands("plan and design", ["/plan"])).toEqual(["/plan"]);
  });

  it("matches case-insensitively", () => {
    expect(suggestCommands("PLAN the work", ["/plan"])).toEqual(["/plan"]);
  });
});

describe("buildIdleSuggestions", () => {
  it("returns the default trio when there is no last message", () => {
    expect(buildIdleSuggestions(undefined)).toEqual([
      "Continue",
      "Explain what you did",
      "What's next?",
    ]);
  });

  it("adds 'Run the tests' for test-related text", () => {
    // A single matched keyword yields one extra + "Continue" -> length 2.
    // (Only the no-message branch is guaranteed length 3 — see below.)
    const result = buildIdleSuggestions("ran the test suite");
    expect(result).toContain("Run the tests");
    expect(result).toEqual(["Run the tests", "Continue"]);
  });

  it("adds 'Commit this' for commit-related text", () => {
    const result = buildIdleSuggestions("ready to commit");
    expect(result).toContain("Commit this");
    expect(result).toEqual(["Commit this", "Continue"]);
  });

  it("caps extras at 2, then appends Continue (length 3)", () => {
    // text hits test, commit, error and plan keywords -> 4 extras, capped to 2.
    const result = buildIdleSuggestions("the test failed, plan a commit fix");
    expect(result).toHaveLength(3);
    expect(result[2]).toBe("Continue");
    expect(result.slice(0, 2)).toEqual(["Run the tests", "Commit this"]);
  });

  it("returns 3 suggestions only when 2+ extras match or no message is given", () => {
    // No message -> early-return trio (length 3).
    expect(buildIdleSuggestions(undefined)).toHaveLength(3);
    // No keyword match -> "What's next?" + "Continue" (length 2).
    expect(buildIdleSuggestions("nothing special here")).toHaveLength(2);
    // Single keyword -> one extra + "Continue" (length 2).
    expect(buildIdleSuggestions("commit it")).toHaveLength(2);
  });
});
