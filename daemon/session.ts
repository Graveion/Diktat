import type { ServerWebSocket } from "bun";
import { existsSync } from "fs";
import { saveSession, loadSession, type SessionData } from "./session-store";
import { sendPushNotification } from "./push";
import { buildToolUsePreview, buildToolResultPreview } from "./tool-preview";
import {
  newRunAccumulator,
  accumulateToolEvent,
  finalizeRunSummary,
  formatPushTitle,
  formatPushBody,
  summaryToPushData,
  type RunAccumulator,
} from "./run-summary";

function pickToolPath(input: any): string | undefined {
  if (!input) return undefined;
  if (typeof input.file_path === "string") return input.file_path;
  if (typeof input.path === "string") return input.path;
  return undefined;
}

/** Strip ANSI escape sequences (Kiro's CLI emits color/spinner codes). */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b[<-?]?[0-9;]*[a-zA-Z]/g, "");
}

function buildArgs(cli: string, cliPath: string, text: string, cliSessionId?: string, mode?: string, resume?: boolean): string[] {
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
    case "copilot":
      // GitHub Copilot CLI. v1 streams the plain response text (--silent), which
      // the daemon forwards verbatim — no JSONL schema to parse yet. We own the
      // session UUID: --session-id sets it for a new session and resumes it
      // thereafter, so follow-ups continue the same conversation.
      return [
        cliPath, "-p", text,
        "--allow-all-tools",
        "--silent",
        "--no-color",
        ...(cliSessionId ? ["--session-id", cliSessionId] : []),
      ];
    case "kiro":
      // Kiro CLI. The assistant is `kiro-cli chat`; --no-interactive runs it
      // headless and prints the response text (no JSONL schema). Kiro has no
      // settable session id, so we continue a session with --resume (most
      // recent conversation in the project dir). INPUT is positional → last.
      return [
        cliPath, "chat", "--no-interactive", "--trust-all-tools",
        ...(resume ? ["--resume"] : []),
        text,
      ];
    case "codex":
      // Codex CLI. `codex exec` is the non-interactive runner; PROMPT is
      // positional. Autonomous but sandboxed (never-ask + workspace-write).
      // Multi-turn resume is not wired yet — each turn is a fresh exec. Output
      // is plain text (ANSI-stripped). See agents.ts.
      return [
        cliPath, "exec",
        "--ask-for-approval", "never",
        "--sandbox", "workspace-write",
        text,
      ];
    default:
      throw new Error(`Unknown CLI: ${cli}`);
  }
}

export class Session {
  private ws: ServerWebSocket<unknown>;
  private data: SessionData;
  private activeProc: ReturnType<typeof Bun.spawn> | null = null;
  // Per-run accumulator of what the agent actually did (files/lines/tests/etc.).
  // Reset at the top of each runCLI; consumed when building the completion push.
  private run: RunAccumulator = newRunAccumulator();

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

  // Open a past Codex conversation for viewing. Codex has no live resume
  // (each turn is a fresh `codex exec`), so cliSessionId is kept only for
  // reference/display — sending a follow-up starts a new exec.
  static fromCodexSession(ws: ServerWebSocket<unknown>, cliSessionId: string, project: string, cliPath: string): Session {
    const data: SessionData = {
      id: crypto.randomUUID(),
      cli: "codex",
      cliPath,
      project,
      cliSessionId,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    };
    saveSession(data);
    return new Session(ws, data);
  }

  // Open a past Copilot conversation. Copilot resumes by session UUID
  // (--session-id), so keeping cliSessionId means a follow-up continues it.
  static fromCopilotSession(ws: ServerWebSocket<unknown>, cliSessionId: string, project: string, cliPath: string): Session {
    const data: SessionData = {
      id: crypto.randomUUID(),
      cli: "copilot",
      cliPath,
      project,
      cliSessionId,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    };
    saveSession(data);
    return new Session(ws, data);
  }

  // Open a past Kiro conversation. Kiro resumes the most-recent conversation in
  // a directory (--resume), so we bind to its cwd and mark it started; a
  // follow-up resumes it. (Kiro has no settable per-conversation id.)
  static fromKiroSession(ws: ServerWebSocket<unknown>, project: string, cliPath: string): Session {
    const data: SessionData = {
      id: crypto.randomUUID(),
      cli: "kiro",
      cliPath,
      project,
      started: true,
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

  cancel(): void {
    this.activeProc?.kill();
    this.activeProc = null;
  }

  async send(text: string, pushToken?: string): Promise<void> {
    const CLI_FALLBACK: Record<string, string> = { claude: "claude", cursor: "agent", copilot: "copilot", kiro: "kiro-cli", codex: "codex" };
    const cliPath = this.data.cliPath ?? CLI_FALLBACK[this.data.cli] ?? this.data.cli;
    const cwd = existsSync(this.data.project) ? this.data.project : process.env.HOME ?? process.cwd();
    await this.runCLI(cliPath, cwd, text, pushToken);
  }

  private async runCLI(cliPath: string, cwd: string, text: string, pushToken?: string, retry = false): Promise<void> {
    // Reset the per-run accumulator at the start of a fresh run. On the retry
    // path we keep the original start time but clear any partial state.
    this.run = newRunAccumulator(retry ? this.run.startedAt : Date.now());
    // Copilot lets us own the session UUID (--session-id both creates and
    // resumes), so mint one up front the first time we run this session.
    if (this.data.cli === "copilot" && !this.data.cliSessionId && !retry) {
      this.data.cliSessionId = crypto.randomUUID();
      saveSession(this.data);
    }
    const sessionId = retry ? undefined : this.data.cliSessionId;
    // Kiro: after the first turn, resume the most recent conversation in this dir.
    const kiroResume = this.data.cli === "kiro" && !!this.data.started && !retry;
    const args = buildArgs(this.data.cli, cliPath, text, sessionId, this.data.mode, kiroResume);
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
        } else if (!isStderr && (this.data.cli === "kiro" || this.data.cli === "codex")) {
          // Kiro/Codex print styled text; strip ANSI before forwarding.
          const clean = stripAnsi(chunk);
          if (clean) this.ws.send(JSON.stringify({ type: "output", text: clean }));
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
    // Kiro: mark the conversation as started so the next turn resumes it.
    if (this.data.cli === "kiro") this.data.started = true;
    saveSession(this.data);

    const exitCode = await proc.exited;
    this.ws.send(JSON.stringify({ type: "exit", code: exitCode }));

    // Only push if the WebSocket has since closed — if it's still open the app
    // is in the foreground and already received the exit message directly.
    const wsStillOpen = (this.ws as any).readyState === 1;
    if (pushToken && exitCode === 0 && !wsStillOpen) {
      const project = this.data.project.split("/").pop() ?? this.data.project;
      const summary = finalizeRunSummary(this.run, exitCode);
      const title = formatPushTitle(project, exitCode);
      const body = formatPushBody(summary);
      const data = summaryToPushData(this.data.id, summary);
      await sendPushNotification(pushToken, title, body, data);
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
              const preview = buildToolUsePreview(block.name, block.input);
              const path = pickToolPath(block.input);
              accumulateToolEvent(this.run, {
                kind: "tool_use",
                name: block.name,
                id: block.id,
                path,
                diff: preview.diff,
                content: typeof block.input?.content === "string" ? block.input.content : undefined,
                command: preview.command,
              });
              this.ws.send(JSON.stringify({
                type: "tool_use",
                id: block.id,
                name: block.name,
                ...(path ? { path } : {}),
                ...(preview.diff ? { diff: preview.diff } : {}),
                ...(preview.preview ? { preview: preview.preview } : {}),
                ...(preview.command ? { command: preview.command } : {}),
                ...(preview.truncated ? { truncated: true } : {}),
                ...(preview.fullSize ? { fullSize: preview.fullSize } : {}),
              }));
            }
          }
        } else if (json.type === "user" && Array.isArray(json.message?.content)) {
          // Tool results arrive in subsequent user entries during -p stream-json.
          for (const block of json.message.content) {
            if (block?.type !== "tool_result") continue;
            const result = buildToolResultPreview(block.content);
            if (!result) continue;
            accumulateToolEvent(this.run, {
              kind: "tool_result",
              id: block.tool_use_id,
              preview: result.preview,
            });
            this.ws.send(JSON.stringify({
              type: "tool_result",
              toolUseId: block.tool_use_id,
              preview: result.preview,
              truncated: result.truncated,
              fullSize: result.fullSize,
            }));
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
              // Strip Cursor's [redacted] markers and send the cleaned text.
              const text = block.text.replace(/\[redacted\]/gi, "").trim();
              if (text) this.ws.send(JSON.stringify({ type: "output", text }));
            }
          }
        }

        if (json.type === "tool_call") {
          this.handleCursorToolCall(json);
        }
      } catch {
        // non-JSON stderr etc, ignore
      }
    }
  }

  // Detect which tool wrapper is set on a Cursor tool_call and return:
  //   name           — our display name (Read/Write/Edit/Bash/...)
  //   wrapper        — the per-tool wrapper object (readToolCall, etc.)
  //   anthropicInput — args remapped to Anthropic-style field names so
  //                    buildToolUsePreview/path extraction work uniformly.
  private extractCursorTool(tc: any): { name: string; wrapper: any; anthropicInput: any } | null {
    if (!tc || typeof tc !== "object") return null;
    if (tc.readToolCall) {
      const a = tc.readToolCall.args ?? {};
      return { name: "Read", wrapper: tc.readToolCall, anthropicInput: { file_path: a.path } };
    }
    if (tc.writeToolCall) {
      const a = tc.writeToolCall.args ?? {};
      // Cursor uses `fileText`; remap to Anthropic's `content` so Write previews work.
      return { name: "Write", wrapper: tc.writeToolCall, anthropicInput: { file_path: a.path, content: a.fileText } };
    }
    if (tc.editToolCall) {
      const a = tc.editToolCall.args ?? {};
      // Edit args are not in the public docs; probe both snake_case and camelCase.
      return {
        name: "Edit",
        wrapper: tc.editToolCall,
        anthropicInput: {
          file_path: a.path,
          old_string: a.old_string ?? a.oldString ?? a.oldText ?? a.old,
          new_string: a.new_string ?? a.newString ?? a.newText ?? a.new,
        },
      };
    }
    if (tc.bashToolCall) {
      const a = tc.bashToolCall.args ?? {};
      return { name: "Bash", wrapper: tc.bashToolCall, anthropicInput: { command: a.command ?? a.cmd ?? a.script } };
    }
    if (tc.searchToolCall) {
      const a = tc.searchToolCall.args ?? {};
      return { name: "Grep", wrapper: tc.searchToolCall, anthropicInput: { command: a.query ?? a.pattern } };
    }
    if (tc.webToolCall) {
      const a = tc.webToolCall.args ?? {};
      return { name: "WebFetch", wrapper: tc.webToolCall, anthropicInput: { command: a.url } };
    }
    return null;
  }

  // Pull a useful text payload out of a Cursor tool result.success object.
  private extractCursorResultText(name: string, success: any): string | null {
    if (!success || typeof success !== "object") return null;
    switch (name) {
      case "Read":
        return typeof success.content === "string" ? success.content : null;
      case "Write": {
        const path = typeof success.path === "string" ? success.path : "";
        const lines = typeof success.linesCreated === "number" ? success.linesCreated : null;
        const size = typeof success.fileSize === "number" ? success.fileSize : null;
        const parts: string[] = [];
        if (path) parts.push(`Wrote ${path}`);
        if (lines !== null) parts.push(`${lines} lines`);
        if (size !== null) parts.push(`${size} bytes`);
        return parts.length ? parts.join(" · ") : null;
      }
      default:
        // Fields aren't documented for Edit/Bash/etc. — probe common shapes.
        if (typeof success.output === "string") return success.output;
        if (typeof success.content === "string") return success.content;
        if (typeof success.text === "string") return success.text;
        if (typeof success.stdout === "string") {
          return success.stderr ? `${success.stdout}\n[stderr]\n${success.stderr}` : success.stdout;
        }
        return null;
    }
  }

  private handleCursorToolCall(json: any): void {
    const callId: string | undefined = typeof json.call_id === "string" ? json.call_id : undefined;
    const extracted = this.extractCursorTool(json.tool_call);
    if (!extracted) return;
    const { name, wrapper, anthropicInput } = extracted;
    const path = pickToolPath(anthropicInput);

    if (json.subtype === "started") {
      const preview = buildToolUsePreview(name, anthropicInput);
      accumulateToolEvent(this.run, {
        kind: "tool_use",
        name,
        ...(callId ? { id: callId } : {}),
        ...(path ? { path } : {}),
        diff: preview.diff,
        content: typeof anthropicInput?.content === "string" ? anthropicInput.content : undefined,
        command: preview.command,
      });
      this.ws.send(JSON.stringify({
        type: "tool_use",
        ...(callId ? { id: callId } : {}),
        name,
        ...(path ? { path } : {}),
        ...(preview.diff ? { diff: preview.diff } : {}),
        ...(preview.preview ? { preview: preview.preview } : {}),
        ...(preview.command ? { command: preview.command } : {}),
        ...(preview.truncated ? { truncated: true } : {}),
        ...(preview.fullSize ? { fullSize: preview.fullSize } : {}),
      }));
      return;
    }

    if (json.subtype === "completed") {
      if (!callId) return;
      const success = wrapper?.result?.success;
      const text = this.extractCursorResultText(name, success);
      if (!text) return;
      const result = buildToolResultPreview(text);
      if (!result) return;
      accumulateToolEvent(this.run, {
        kind: "tool_result",
        id: callId,
        preview: result.preview,
      });
      this.ws.send(JSON.stringify({
        type: "tool_result",
        toolUseId: callId,
        preview: result.preview,
        truncated: result.truncated,
        fullSize: result.fullSize,
      }));
    }
  }
}
