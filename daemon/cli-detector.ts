const KNOWN_CLIS: Record<string, string> = {
  claude: "claude",
  cursor: "agent",  // Cursor's agent CLI is the standalone 'agent' binary
};

async function resolvePath(command: string): Promise<string | null> {
  // Get the path from `which`
  const whichProc = Bun.spawn(["which", command], { stdout: "pipe", stderr: "pipe" });
  const whichText = await new Response(whichProc.stdout).text();
  await whichProc.exited;
  if (whichProc.exitCode !== 0) return null;
  const whichPath = whichText.trim();
  if (!whichPath) return null;

  // Resolve symlinks so Bun.spawn gets the real executable path
  const realProc = Bun.spawn(["readlink", "-f", whichPath], { stdout: "pipe", stderr: "pipe" });
  const realText = await new Response(realProc.stdout).text();
  await realProc.exited;
  const resolved = realText.trim();
  return resolved || whichPath;
}

// Returns a map of CLI name → absolute path (e.g. { claude: "/Users/foo/.local/bin/claude" })
export async function detectCLIs(): Promise<Record<string, string>> {
  const available: Record<string, string> = {};
  for (const [name, command] of Object.entries(KNOWN_CLIS)) {
    const fullPath = await resolvePath(command);
    if (fullPath) {
      available[name] = fullPath;
    }
  }
  return available;
}
