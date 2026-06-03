const KNOWN_CLIS: Record<string, string> = {
  claude: "claude",
  cursor: "agent",  // Cursor's agent CLI is the standalone 'agent' binary
};

/** Minimal shape of a spawned process we depend on — lets tests inject a stub. */
export interface SpawnedProc {
  stdout: ReadableStream<Uint8Array> | any;
  exited: Promise<number>;
  exitCode: number | null;
}

export type SpawnFn = (cmd: string[]) => SpawnedProc;

const defaultSpawn: SpawnFn = (cmd) =>
  Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" }) as unknown as SpawnedProc;

export async function resolvePath(command: string, spawn: SpawnFn = defaultSpawn): Promise<string | null> {
  // Get the path from `which`
  const whichProc = spawn(["which", command]);
  const whichText = await new Response(whichProc.stdout).text();
  await whichProc.exited;
  if (whichProc.exitCode !== 0) return null;
  const whichPath = whichText.trim();
  if (!whichPath) return null;

  // Resolve symlinks so Bun.spawn gets the real executable path
  const realProc = spawn(["readlink", "-f", whichPath]);
  const realText = await new Response(realProc.stdout).text();
  await realProc.exited;
  const resolved = realText.trim();
  return resolved || whichPath;
}

// Returns a map of CLI name → absolute path (e.g. { claude: "/Users/foo/.local/bin/claude" })
export async function detectCLIs(spawn: SpawnFn = defaultSpawn): Promise<Record<string, string>> {
  const available: Record<string, string> = {};
  for (const [name, command] of Object.entries(KNOWN_CLIS)) {
    const fullPath = await resolvePath(command, spawn);
    if (fullPath) {
      available[name] = fullPath;
    }
  }
  return available;
}
