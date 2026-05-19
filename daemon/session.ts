import type { ServerWebSocket } from "bun";
import { saveSession, loadSession, type SessionData } from "./session-store";

function buildArgs(cli: string, text: string, cliSessionId?: string): string[] {
  switch (cli) {
    case "claude":
      return [
        "claude", "-p", text,
        "--output-format", "stream-json",
        "--verbose",
        ...(cliSessionId ? ["--resume", cliSessionId] : []),
      ];
    case "cursor":
      return [
        "agent", "--trust", "-p", text,
        ...(cliSessionId ? [`--resume=${cliSessionId}`] : []),
      ];
    default:
      throw new Error(`Unknown CLI: ${cli}`);
  }
}

export class Session {
  private ws: ServerWebSocket<unknown>;
  private data: SessionData;

  constructor(ws: ServerWebSocket<unknown>, data: SessionData) {
    this.ws = ws;
    this.data = data;
  }

  static create(ws: ServerWebSocket<unknown>, cli: string, project: string): Session {
    const data: SessionData = {
      id: crypto.randomUUID(),
      cli,
      project,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    };
    saveSession(data);
    return new Session(ws, data);
  }

  static resume(ws: ServerWebSocket<unknown>, id: string): Session | null {
    const data = loadSession(id);
    if (!data) return null;
    return new Session(ws, data);
  }

  static fromClaudeSession(ws: ServerWebSocket<unknown>, cliSessionId: string, project: string): Session {
    const data: SessionData = {
      id: crypto.randomUUID(),
      cli: "claude",
      project,
      cliSessionId,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    };
    saveSession(data);
    return new Session(ws, data);
  }

  static fromCursorSession(ws: ServerWebSocket<unknown>, cliSessionId: string, project: string): Session {
    const data: SessionData = {
      id: crypto.randomUUID(),
      cli: "cursor",
      project,
      cliSessionId,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    };
    saveSession(data);
    return new Session(ws, data);
  }

  get id(): string {
    return this.data.id;
  }

  get summary() {
    return {
      id: this.data.id,
      cli: this.data.cli,
      project: this.data.project,
      cliSessionId: this.data.cliSessionId,
      lastActiveAt: this.data.lastActiveAt,
    };
  }

  async send(text: string): Promise<void> {
    const proc = Bun.spawn(buildArgs(this.data.cli, text, this.data.cliSessionId), {
      cwd: this.data.project,
      stdout: "pipe",
      stderr: "pipe",
    });

    const streamOutput = async (stream: ReadableStream<Uint8Array>, isStderr: boolean) => {
      const decoder = new TextDecoder();
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        if (!isStderr && this.data.cli === "claude") {
          this.parseClaudeChunk(chunk);
        } else {
          this.ws.send(JSON.stringify({ type: "output", text: chunk }));
        }
      }
    };

    await Promise.all([streamOutput(proc.stdout, false), streamOutput(proc.stderr, true)]);

    this.data.lastActiveAt = new Date().toISOString();
    saveSession(this.data);

    this.ws.send(JSON.stringify({ type: "exit", code: await proc.exited }));
  }

  private parseClaudeChunk(chunk: string): void {
    for (const line of chunk.split("\n").filter(Boolean)) {
      try {
        const json = JSON.parse(line);
        if (json.session_id && !this.data.cliSessionId) {
          this.data.cliSessionId = json.session_id;
        }
        if (json.type === "assistant") {
          for (const block of json.message?.content ?? []) {
            if (block.type === "text") {
              this.ws.send(JSON.stringify({ type: "output", text: block.text }));
            }
          }
        }
      } catch {
        this.ws.send(JSON.stringify({ type: "output", text: line }));
      }
    }
  }
}
