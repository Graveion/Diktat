import type { ServerWebSocket } from "bun";
import { existsSync } from "fs";
import { saveSession, loadSession, type SessionData } from "./session-store";
import { sendPushNotification } from "./push";

function buildArgs(cli: string, cliPath: string, text: string, cliSessionId?: string, mode?: string): string[] {
  switch (cli) {
    case "claude":
      return [
        cliPath, "-p", text,
        "--output-format", "stream-json",
        "--verbose",
        ...(cliSessionId ? ["--resume", cliSessionId] : []),
      ];
    case "cursor":
      return [
        cliPath, "--trust", "-p", text,
        "--output-format", "stream-json",
        "--stream-partial-output",
        ...(cliSessionId ? [`--resume=${cliSessionId}`] : []),
        ...(mode ? ["--mode", mode] : []),
      ];
    default:
      throw new Error(`Unknown CLI: ${cli}`);
  }
}

export class Session {
  private ws: ServerWebSocket<unknown>;
  private data: SessionData;
  private activeProc: ReturnType<typeof Bun.spawn> | null = null;

  constructor(ws: ServerWebSocket<unknown>, data: SessionData) {
    this.ws = ws;
    this.data = data;
  }

  static create(ws: ServerWebSocket<unknown>, cli: string, cliPath: string, project: string, mode?: string): Session {
    const data: SessionData = {
      id: crypto.randomUUID(),
      cli,
      cliPath,
      project,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      ...(mode ? { mode } : {}),
    };
    saveSession(data);
    return new Session(ws, data);
  }

  static resume(ws: ServerWebSocket<unknown>, id: string): Session | null {
    const data = loadSession(id);
    if (!data) return null;
    return new Session(ws, data);
  }

  static fromClaudeSession(ws: ServerWebSocket<unknown>, cliSessionId: string, project: string, cliPath: string): Session {
    const data: SessionData = {
      id: crypto.randomUUID(),
      cli: "claude",
      cliPath,
      project,
      cliSessionId,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    };
    saveSession(data);
    return new Session(ws, data);
  }

  static fromCursorSession(ws: ServerWebSocket<unknown>, cliSessionId: string, project: string, cliPath: string, mode?: string): Session {
    const data: SessionData = {
      id: crypto.randomUUID(),
      cli: "cursor",
      cliPath,
      project,
      cliSessionId,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      ...(mode ? { mode } : {}),
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

  cancel(): void {
    this.activeProc?.kill();
    this.activeProc = null;
  }

  async send(text: string, pushToken?: string): Promise<void> {
    const CLI_FALLBACK: Record<string, string> = { claude: "claude", cursor: "agent" };
    const cliPath = this.data.cliPath ?? CLI_FALLBACK[this.data.cli] ?? this.data.cli;
    const cwd = existsSync(this.data.project) ? this.data.project : process.env.HOME ?? process.cwd();
    await this.runCLI(cliPath, cwd, text, pushToken);
  }

  private async runCLI(cliPath: string, cwd: string, text: string, pushToken?: string, retry = false): Promise<void> {
    const sessionId = retry ? undefined : this.data.cliSessionId;
    const args = buildArgs(this.data.cli, cliPath, text, sessionId, this.data.mode);
    const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
    this.activeProc = proc;

    let needsRetry = false;
    const streamOutput = async (stream: ReadableStream<Uint8Array>, isStderr: boolean) => {
      const decoder = new TextDecoder();
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        if (!isStderr && this.data.cli === "claude") {
          if (this.parseClaudeChunk(chunk)) needsRetry = true;
        } else if (!isStderr && this.data.cli === "cursor") {
          this.parseCursorChunk(chunk);
        } else {
          this.ws.send(JSON.stringify({ type: "output", text: chunk }));
        }
      }
    };

    await Promise.all([streamOutput(proc.stdout, false), streamOutput(proc.stderr, true)]);

    // Claude said "no conversation found" — clear stale session ID and retry fresh
    if (needsRetry && !retry) {
      this.activeProc = null;
      this.data.cliSessionId = undefined;
      saveSession(this.data);
      await this.runCLI(cliPath, cwd, text, pushToken, true);
      return;
    }
    this.activeProc = null;

    this.data.lastActiveAt = new Date().toISOString();
    saveSession(this.data);

    const exitCode = await proc.exited;
    this.ws.send(JSON.stringify({ type: "exit", code: exitCode }));

    // Only push if the WebSocket has since closed — if it's still open the app
    // is in the foreground and already received the exit message directly.
    const wsStillOpen = (this.ws as any).readyState === 1;
    if (pushToken && exitCode === 0 && !wsStillOpen) {
      const project = this.data.project.split("/").pop() ?? this.data.project;
      const taskPreview = text.length > 80 ? text.slice(0, 77) + "…" : text;
      await sendPushNotification(pushToken, `✓ ${project}`, taskPreview, { sessionId: this.data.id });
    }
  }

  private parseClaudeChunk(chunk: string): boolean {
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
            } else if (block.type === "tool_use") {
              this.ws.send(JSON.stringify({ type: "tool_use", name: block.name }));
            }
          }
        }
      } catch {
        // Plain text line — check for "no conversation found" before forwarding
        if (/no conversation found/i.test(line)) {
          return true; // signal: needs retry without --resume
        }
        this.ws.send(JSON.stringify({ type: "output", text: line }));
      }
    }
    return false;
  }

  private parseCursorChunk(chunk: string): void {
    for (const line of chunk.split("\n").filter(Boolean)) {
      try {
        const json = JSON.parse(line);
        // Capture session_id from any event that carries it
        if (json.session_id && !this.data.cliSessionId) {
          this.data.cliSessionId = json.session_id;
          saveSession(this.data);
        }
        // Streaming text deltas: timestamp_ms present + no model_call_id = incremental delta
        if (json.type === "assistant" && json.timestamp_ms && !json.model_call_id) {
          const content = json.message?.content ?? [];
          for (const block of content) {
            if (block.type === "text" && block.text) {
              const text = block.text.replace(/\[redacted\]/gi, "").trim();
              if (text) this.ws.send(JSON.stringify({ type: "output", text: block.text }));
            }
          }
        }

        // Dedicated tool_call events give us the tool type and file path
        if (json.type === "tool_call" && json.subtype === "started") {
          const tc = json.tool_call ?? {};
          let name = "Tool";
          let path: string | undefined;
          if (tc.readToolCall)        { name = "Read";  path = tc.readToolCall.args?.path; }
          else if (tc.writeToolCall)  { name = "Write"; path = tc.writeToolCall.args?.path; }
          else if (tc.editToolCall)   { name = "Edit";  path = tc.editToolCall.args?.path; }
          else if (tc.bashToolCall)   { name = "Bash"; }
          else if (tc.searchToolCall) { name = "Grep"; }
          else if (tc.webToolCall)    { name = "WebFetch"; }
          this.ws.send(JSON.stringify({ type: "tool_use", name, ...(path ? { path } : {}) }));
        }
      } catch {
        // non-JSON stderr etc, ignore
      }
    }
  }
}
