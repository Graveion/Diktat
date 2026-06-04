import { suggestCommands } from "../suggestions";

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
