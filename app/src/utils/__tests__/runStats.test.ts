import { computeRunStats, formatRunDuration } from "../runStats";
import type { DiktatMessage } from "../../hooks/useDiktat";

const tool = (toolName: string, extra: Partial<DiktatMessage> = {}): DiktatMessage => ({
  role: "tool", text: "", toolName, ...extra,
});

describe("computeRunStats", () => {
  it("returns null when nothing actionable happened", () => {
    expect(computeRunStats([])).toBeNull();
    expect(computeRunStats([{ role: "assistant", text: "hi" }, tool("Read:a.ts", { toolPath: "/a.ts" })])).toBeNull();
  });

  it("counts unique edited files, edits, and diff lines", () => {
    const stats = computeRunStats([
      tool("Edit:a.ts", { toolPath: "/a.ts", toolDiff: "+ one\n+ two\n- old" }),
      tool("Edit:a.ts", { toolPath: "/a.ts", toolDiff: "+ three" }),
      tool("Write:b.ts", { toolPath: "/b.ts", toolDiff: "+ x\n+ y" }),
    ]);
    expect(stats).toEqual({ files: 2, edits: 3, commands: 0, added: 5, removed: 1 });
  });

  it("counts bash commands separately", () => {
    const stats = computeRunStats([
      tool("Bash", { toolCommand: "npm test" }),
      tool("Bash", { toolCommand: "ls" }),
      tool("Edit:a.ts", { toolPath: "/a.ts" }),
    ]);
    expect(stats).toMatchObject({ commands: 2, edits: 1, files: 1 });
  });

  it("ignores non-+/- lines and diff headers", () => {
    const stats = computeRunStats([
      tool("Edit:a.ts", { toolPath: "/a.ts", toolDiff: "@@ ctx @@\n+ added\ncontext line\n- removed" }),
    ]);
    expect(stats).toMatchObject({ added: 1, removed: 1 });
  });
});

describe("formatRunDuration", () => {
  it("formats sub-minute, minute, and minute+seconds", () => {
    expect(formatRunDuration(45_000)).toBe("45s");
    expect(formatRunDuration(120_000)).toBe("2m");
    expect(formatRunDuration(80_000)).toBe("1m20s");
  });
});
