import type { ServerWebSocket } from "bun";

const CLI_ARGS: Record<string, (text: string) => string[]> = {
  claude: (text) => ["claude", "-p", text],
  cursor: (text) => ["cursor", "agent", "-p", text],
};

export class Session {
  private ws: ServerWebSocket<unknown>;
  private cli: string;
  private project: string;

  constructor(ws: ServerWebSocket<unknown>, cli: string, project: string) {
    this.ws = ws;
    this.cli = cli;
    this.project = project;
  }

  async send(text: string): Promise<void> {
    const buildArgs = CLI_ARGS[this.cli];
    if (!buildArgs) {
      this.ws.send(JSON.stringify({ type: "error", message: `Unknown CLI: ${this.cli}` }));
      return;
    }

    const proc = Bun.spawn(buildArgs(text), {
      cwd: this.project,
      stdout: "pipe",
      stderr: "pipe",
    });

    this.streamOutput(proc.stdout);
    this.streamOutput(proc.stderr);

    const exitCode = await proc.exited;
    this.ws.send(JSON.stringify({ type: "exit", code: exitCode }));
  }

  private async streamOutput(stream: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      this.ws.send(JSON.stringify({ type: "output", text: decoder.decode(value) }));
    }
  }
}
