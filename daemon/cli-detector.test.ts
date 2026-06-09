import { test, expect } from "bun:test";
import { resolvePath, detectCLIs, type SpawnFn, type SpawnedProc } from "./cli-detector";

/** Build a stub spawned process that yields `out` on stdout and the given exit code. */
function stubProc(out: string, exitCode: number): SpawnedProc {
  return {
    stdout: new Response(out).body as any,
    exited: Promise.resolve(exitCode),
    exitCode,
  };
}

/**
 * Build a SpawnFn that responds based on the command. `which` lookups consult
 * `whichResults`; `readlink` echoes a resolved path.
 */
function stubSpawn(opts: {
  whichResults: Record<string, { out: string; code: number }>;
  readlinkOut?: string;
}): SpawnFn {
  return (cmd: string[]) => {
    if (cmd[0] === "which") {
      const r = opts.whichResults[cmd[1]!] ?? { out: "", code: 1 };
      return stubProc(r.out, r.code);
    }
    if (cmd[0] === "readlink") {
      return stubProc(opts.readlinkOut ?? cmd[2] ?? "", 0);
    }
    return stubProc("", 1);
  };
}

test("resolvePath: returns null when `which` exits non-zero", async () => {
  const spawn = stubSpawn({ whichResults: { foo: { out: "", code: 1 } } });
  expect(await resolvePath("foo", spawn)).toBeNull();
});

test("resolvePath: returns null when `which` output is empty", async () => {
  const spawn = stubSpawn({ whichResults: { foo: { out: "   \n", code: 0 } } });
  expect(await resolvePath("foo", spawn)).toBeNull();
});

test("resolvePath: returns resolved symlink path", async () => {
  const spawn = stubSpawn({
    whichResults: { claude: { out: "/usr/local/bin/claude\n", code: 0 } },
    readlinkOut: "/real/path/to/claude\n",
  });
  expect(await resolvePath("claude", spawn)).toBe("/real/path/to/claude");
});

test("resolvePath: falls back to which path when readlink yields empty", async () => {
  const spawn = stubSpawn({
    whichResults: { claude: { out: "/usr/local/bin/claude\n", code: 0 } },
    readlinkOut: "",
  });
  expect(await resolvePath("claude", spawn)).toBe("/usr/local/bin/claude");
});

test("detectCLIs: only includes CLIs found on PATH", async () => {
  const spawn = stubSpawn({
    whichResults: {
      claude: { out: "/bin/claude\n", code: 0 },
      agent: { out: "", code: 1 }, // cursor's binary not found
    },
    readlinkOut: "/bin/claude\n",
  });
  const result = await detectCLIs(spawn);
  expect(result.claude).toBe("/bin/claude");
  expect(result.cursor).toBeUndefined();
});

test("detectCLIs: includes all when they resolve", async () => {
  const paths: Record<string, string> = {
    claude: "/bin/claude\n",
    agent: "/bin/agent\n",
    copilot: "/bin/copilot\n",
    "kiro-cli": "/bin/kiro-cli\n",
    codex: "/bin/codex\n",
  };
  const spawn: SpawnFn = (cmd) => {
    if (cmd[0] === "which") {
      return stubProc(paths[cmd[1]!] ?? "/bin/unknown\n", 0);
    }
    return stubProc(cmd[2] ?? "", 0); // readlink echoes input
  };
  const result = await detectCLIs(spawn);
  expect(result).toEqual({ claude: "/bin/claude", cursor: "/bin/agent", copilot: "/bin/copilot", kiro: "/bin/kiro-cli", codex: "/bin/codex" });
});

test("detectCLIs: empty when nothing on PATH", async () => {
  const spawn = stubSpawn({ whichResults: {} });
  expect(await detectCLIs(spawn)).toEqual({});
});
