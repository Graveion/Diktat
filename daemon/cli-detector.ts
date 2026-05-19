const KNOWN_CLIS: Record<string, string> = {
  claude: "claude",
  cursor: "cursor",
};

async function isAvailable(command: string): Promise<boolean> {
  const proc = Bun.spawn(["which", command], { stdout: "pipe", stderr: "pipe" });
  await proc.exited;
  return proc.exitCode === 0;
}

export async function detectCLIs(): Promise<Record<string, string>> {
  const available: Record<string, string> = {};
  for (const [name, command] of Object.entries(KNOWN_CLIS)) {
    if (await isAvailable(command)) {
      available[name] = command;
    }
  }
  return available;
}
