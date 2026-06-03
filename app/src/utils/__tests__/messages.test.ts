import { mergeSessions, toolDisplayString, appendOutput } from "../messages";
import type { DiktatMessage } from "../../hooks/useDiktat";

describe("mergeSessions", () => {
  it("returns [] for fully empty input", () => {
    expect(mergeSessions({})).toEqual([]);
    expect(mergeSessions({ sessions: [], claudeSessions: [], cursorSessions: [] })).toEqual([]);
  });

  it("tags each source correctly and forces cli for claude/cursor", () => {
    const result = mergeSessions({
      sessions: [{ id: "d1", cli: "codex" }],
      claudeSessions: [{ id: "c1", cli: "ignored" }],
      cursorSessions: [{ id: "u1" }],
    });
    expect(result).toEqual([
      { id: "c1", cli: "claude", source: "claude" },
      { id: "u1", cli: "cursor", source: "cursor" },
      { id: "d1", cli: "codex", source: "daemon" },
    ]);
  });

  it("orders claude, then cursor, then filtered daemon", () => {
    const result = mergeSessions({
      sessions: [{ id: "d1" }],
      claudeSessions: [{ id: "c1" }],
      cursorSessions: [{ id: "u1" }],
    });
    expect(result.map((s) => s.id)).toEqual(["c1", "u1", "d1"]);
    expect(result.map((s) => s.source)).toEqual(["claude", "cursor", "daemon"]);
  });

  it("drops a daemon session whose cliSessionId collides with a claude id", () => {
    const result = mergeSessions({
      sessions: [{ id: "d1", cliSessionId: "c1" }],
      claudeSessions: [{ id: "c1" }],
      cursorSessions: [],
    });
    expect(result.map((s) => s.id)).toEqual(["c1"]);
  });

  it("drops a daemon session whose cliSessionId collides with a cursor id", () => {
    const result = mergeSessions({
      sessions: [{ id: "d1", cliSessionId: "u1" }],
      claudeSessions: [],
      cursorSessions: [{ id: "u1" }],
    });
    expect(result.map((s) => s.id)).toEqual(["u1"]);
  });

  it("keeps a daemon session with no cliSessionId even if a native id matches its own id", () => {
    const result = mergeSessions({
      sessions: [{ id: "c1" }], // no cliSessionId -> never filtered
      claudeSessions: [{ id: "c1" }],
      cursorSessions: [],
    });
    expect(result.map((s) => s.id)).toEqual(["c1", "c1"]);
    expect(result.map((s) => s.source)).toEqual(["claude", "daemon"]);
  });

  it("keeps a daemon session whose cliSessionId does not collide", () => {
    const result = mergeSessions({
      sessions: [{ id: "d1", cliSessionId: "orphan" }],
      claudeSessions: [{ id: "c1" }],
      cursorSessions: [],
    });
    expect(result.map((s) => s.id)).toEqual(["c1", "d1"]);
  });
});

describe("toolDisplayString", () => {
  it("builds Name:lastSegment for a path with directories", () => {
    expect(toolDisplayString("Read", "src/auth/login.ts")).toBe("Read:login.ts");
  });

  it("returns just the name when there is no path", () => {
    expect(toolDisplayString("Bash")).toBe("Bash");
    expect(toolDisplayString("Bash", undefined)).toBe("Bash");
  });

  it("builds Name:filename for a bare filename", () => {
    expect(toolDisplayString("Read", "login.ts")).toBe("Read:login.ts");
  });

  it("returns null when neither name nor path is provided", () => {
    expect(toolDisplayString()).toBeNull();
    expect(toolDisplayString(undefined, undefined)).toBeNull();
  });

  // QUIRK: a trailing-slash path makes split("/").pop() === "" (an empty
  // string, which is NOT nullish), so `?? path` never fires — the result has
  // an empty basename. This mirrors useDiktat.ts exactly; documented, not a bug
  // to "fix" here.
  it("yields an empty basename for a trailing-slash path", () => {
    expect(toolDisplayString("Read", "a/b/")).toBe("Read:");
  });
});

describe("appendOutput", () => {
  it("pushes a new assistant bubble on the first output", () => {
    expect(appendOutput([], "hello")).toEqual([
      { role: "assistant", text: "hello" },
    ]);
  });

  it("merges a second consecutive output into the same assistant bubble", () => {
    const first = appendOutput([], "hello ");
    expect(appendOutput(first, "world")).toEqual([
      { role: "assistant", text: "hello world" },
    ]);
  });

  it("starts a new assistant bubble when the last message is a tool message", () => {
    const prev: DiktatMessage[] = [
      { role: "assistant", text: "before" },
      { role: "tool", text: "", toolName: "Read" },
    ];
    expect(appendOutput(prev, "after")).toEqual([
      { role: "assistant", text: "before" },
      { role: "tool", text: "", toolName: "Read" },
      { role: "assistant", text: "after" },
    ]);
  });

  it("starts a new assistant bubble when the last message is a user message", () => {
    const prev: DiktatMessage[] = [{ role: "user", text: "hi" }];
    expect(appendOutput(prev, "reply")).toEqual([
      { role: "user", text: "hi" },
      { role: "assistant", text: "reply" },
    ]);
  });
});
