import type { ServerWebSocket } from "bun";
import { saveSession, loadSession, type SessionData, type Message } from "./session-store";

function buildArgs(cli: string, text: string, cliSessionId?: string): string[] {
  switch (cli) {
    case "claude":
      return [
        "claude", "-p", text,
        "--output-format", "stream-json",
        ...(cliSessionId ? ["--resume", cliSessionId] : []),
      ];
    case "cursor":
      return [
        "cursor", "agent", "-p", text,
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
      messages: [],
    };
    saveSession(data);
    return new Session(ws, data);
  }

  static resume(ws: ServerWebSocket<unknown>, id: string): Session | null {
    const data = loadSession(id);
    if (!data) return null;
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
      lastActiveAt: this.data.lastActiveAt,
      messageCount: this.data.messages.length,
    };
  }

  async send(text: string): Promise<void> {
    this.addMessage("user", text);

    const args = buildArgs(this.data.cli, text, this.data.cliSessionId);
    const proc = Bun.spawn(args, {
      cwd: this.data.project,
      stdout: "pipe",
      stderr: "pipe",
    });

    let assistantText = "";

    const collectOutput = async (stream: ReadableStream<Uint8Array>, isStderr: boolean) => {
      const decoder = new TextDecoder();
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);

        if (!isStderr && this.data.cli === "claude") {
          assistantText += this.parseClaudeChunk(chunk);
        } else {
          assistantText += chunk;
          this.ws.send(JSON.stringify({ type: "output", text: chunk }));
        }
      }
    };

    await Promise.all([collectOutput(proc.stdout, false), collectOutput(proc.stderr, true)]);

    const exitCode = await proc.exited;

    if (assistantText) this.addMessage("assistant", assistantText);
    this.data.lastActiveAt = new Date().toISOString();
    saveSession(this.data);

    this.ws.send(JSON.stringify({ type: "exit", code: exitCode }));
  }

  private parseClaudeChunk(chunk: string): string {
    let text = "";
    for (const line of chunk.split("\n").filter(Boolean)) {
      try {
        const json = JSON.parse(line);

        if (json.session_id && !this.data.cliSessionId) {
          this.data.cliSessionId = json.session_id;
        }

        if (json.type === "assistant") {
          for (const block of json.message?.content ?? []) {
            if (block.type === "text") {
              text += block.text;
              this.ws.send(JSON.stringify({ type: "output", text: block.text }));
            }
          }
        }
      } catch {
        // non-JSON line — send as-is
        this.ws.send(JSON.stringify({ type: "output", text: line }));
        text += line;
      }
    }
    return text;
  }

  private addMessage(role: Message["role"], text: string): void {
    this.data.messages.push({ role, text, timestamp: new Date().toISOString() });
  }
}
