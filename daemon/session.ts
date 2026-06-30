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
import { permissionFlags, modelFlags, effortFlags, DEFAULT_PERMISSION_MODE, AGENT_CONTRACTS, type PermissionModeId } from "./agents";
import { recordRun } from "./run-stats-store";

/** Kill a CLI that has produced no output for this long. */
export const INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Signatures that mean the agent CLI itself couldn't authenticate with its own
 * provider (e.g. an expired `claude login`) — NOT a Diktat/relay auth problem.
 * Matched against the CLI's stderr only, and only on a non-zero exit, so
 * assistant text that merely mentions "authenticate" can't trip it. When it
 * matches we send a clear, actionable error naming the CLI's login command
 * instead of forwarding a raw "401 Invalid authentication credentials" that
 * reads like the user's own sign-in is broken.
 */
export const AUTH_FAILURE_RE =
  /invalid authentication credentials|failed to authenticate|invalid x-api-key|authentication[_ ]error|\boauth\b.*(expired|invalid)|not (logged in|authenticated|signed in)|please (run|sign in|log\s?in).*(login|auth)|\b401\b|\b403\b|unauthorized/i;

/**
 * Re-assembles complete lines from arbitrary stream chunks — NDJSON events can
 * span two reads, so per-chunk splitting would corrupt them.
 */
export class LineBuffer {
  private carry = "";
  /** Append a chunk; returns the complete lines now available. */
  push(chunk: string): string[] {
    this.carry += chunk;
    const parts = this.carry.split("\n");
    this.carry = parts.pop() ?? "";
    return parts;
  }
  /** Return any trailing partial line (stream end). */
  flush(): string {
    const rest = this.carry;
    this.carry = "";
    return rest;
  }
}

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

// Permission flags (per normalized tier) and the optional --model flag come
// from the agents.ts contract, so this only owns prompt placement + resume.
function buildArgs(
  cli: string,
  cliPath: string,
  text: string,
  cliSessionId?: string,
  permissionMode: PermissionModeId = DEFAULT_PERMISSION_MODE,
  model?: string,
  resume?: boolean,
  effort?: string,
): string[] {
  const perm = permissionFlags(cli, permissionMode);
  const mdl = modelFlags(model);
  const eff = effortFlags(cli, effort); // empty for CLIs that don't support it
  switch (cli) {
    case "claude":
      return [
        cliPath, "-p", text,
        "--output-format", "stream-json",
        "--verbose",
        ...perm, ...mdl, ...eff,
        ...(cliSessionId ? ["--resume", cliSessionId] : []),
      ];
    case "cursor":
      return [
        cliPath, "-p", text,
        "--output-format", "stream-json",
        "--stream-partial-output",
        ...perm, ...mdl, ...eff,
        ...(cliSessionId ? [`--resume=${cliSessionId}`] : []),
      ];
    case "copilot":
      // GitHub Copilot CLI. v1 streams the plain response text (--silent), which
      // the daemon forwards verbatim. We own the session UUID: --session-id sets
      // it for a new session and resumes it thereafter.
      return [
        cliPath, "-p", text,
        "--silent", "--no-color",
        ...perm, ...mdl, ...eff,
        ...(cliSessionId ? ["--session-id", cliSessionId] : []),
      ];
    case "kiro":
      // Kiro CLI. `kiro-cli chat --no-interactive` runs headless. Kiro has no
      // settable session id, so we continue with --resume (most recent in dir).
      // INPUT is positional → last.
      return [
        cliPath, "chat", "--no-interactive",
        ...perm, ...mdl, ...eff,
        ...(resume ? ["--resume"] : []),
        text,
      ];
    case "codex":
      // Codex CLI. `codex exec` is the non-interactive runner; PROMPT is
      // positional. Multi-turn resume not wired (each turn is a fresh exec).
      return [
        cliPath, "exec",
        ...perm, ...mdl, ...eff,
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

  static create(
    ws: ServerWebSocket<unknown>,
    cli: string,
    cliPath: string,
    project: string,
    model?: string,
    permissionMode?: PermissionModeId,
    effort?: string,
  ): Session {
    const data: SessionData = {
      id: crypto.randomUUID(),
      cli,
      cliPath,
      project,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      ...(model ? { model } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(effort ? { effort } : {}),
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
      ...(this.data.model ? { model: this.data.model } : {}),
      ...(this.data.permissionMode ? { permissionMode: this.data.permissionMode } : {}),
    };
  }

  /** Apply per-turn model / permission overrides before the next run. */
  applyOptions(opts: { model?: string; permissionMode?: PermissionModeId; effort?: string }): void {
    let changed = false;
    if (opts.model !== undefined && opts.model !== this.data.model) {
      this.data.model = opts.model || undefined;
      changed = true;
    }
    if (opts.permissionMode && opts.permissionMode !== this.data.permissionMode) {
      this.data.permissionMode = opts.permissionMode;
      changed = true;
    }
    if (opts.effort !== undefined && opts.effort !== this.data.effort) {
      this.data.effort = opts.effort || undefined;
      changed = true;
    }
    if (changed) saveSession(this.data);
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
    const args = buildArgs(this.data.cli, cliPath, text, sessionId, this.data.permissionMode ?? DEFAULT_PERMISSION_MODE, this.data.model, kiroResume, this.data.effort);
    const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
    this.activeProc = proc;

    // Inactivity watchdog: a CLI that goes silent for too long is killed and
    // reported like a cancelled run (exit -1).
    let timedOut = false;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    const bumpWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, INACTIVITY_TIMEOUT_MS);
    };
    bumpWatchdog();

    let needsRetry = false;
    // Keep the tail of stderr so we can detect a provider auth failure on exit.
    let stderrTail = "";
    const streamOutput = async (stream: ReadableStream<Uint8Array>, isStderr: boolean) => {
      const decoder = new TextDecoder();
      const reader = stream.getReader();
      // Claude/Cursor stdout is NDJSON — buffer across chunks so an event split
      // mid-line by the pipe still parses as one line.
      const lineParsed = !isStderr && (this.data.cli === "claude" || this.data.cli === "cursor");
      const buf = new LineBuffer();
      const handleLine = (line: string) => {
        if (!line) return;
        if (this.data.cli === "claude") {
          if (this.parseClaudeChunk(line)) needsRetry = true;
        } else {
          this.parseCursorChunk(line);
        }
      };
      const handleRaw = (chunk: string) => {
        if (!chunk) return;
        if (isStderr) stderrTail = (stderrTail + chunk).slice(-4096);
        if (!isStderr && (this.data.cli === "kiro" || this.data.cli === "codex")) {
          // Kiro/Codex print styled text; strip ANSI before forwarding.
          const clean = stripAnsi(chunk);
          if (clean) this.ws.send(JSON.stringify({ type: "output", text: clean }));
        } else {
          this.ws.send(JSON.stringify({ type: "output", text: chunk }));
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bumpWatchdog();
        const chunk = decoder.decode(value, { stream: true });
        if (lineParsed) {
          for (const line of buf.push(chunk)) handleLine(line);
        } else {
          handleRaw(chunk);
        }
      }
      const tail = decoder.decode(); // flush any buffered partial code point
      if (lineParsed) {
        for (const line of buf.push(tail)) handleLine(line);
        handleLine(buf.flush());
      } else {
        handleRaw(tail);
      }
    };

    await Promise.all([streamOutput(proc.stdout, false), streamOutput(proc.stderr, true)]);
    if (watchdog) clearTimeout(watchdog);

    // Claude said "no conversation found" — clear stale session ID and retry fresh
    if (needsRetry && !retry && !timedOut) {
      await proc.exited;
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

    const rawExit = await proc.exited;
    const exitCode = timedOut ? -1 : rawExit; // timeout reports like a cancel

    // A non-zero exit whose stderr looks like a provider auth failure means the
    // agent CLI on this machine isn't logged in — surface a clear, actionable
    // message instead of leaving the user staring at a raw "401" in the output.
    if (exitCode !== 0 && !timedOut && AUTH_FAILURE_RE.test(stderrTail)) {
      const contract = AGENT_CONTRACTS[this.data.cli];
      const name = contract?.displayName ?? this.data.cli;
      const login = contract?.login.command ?? "re-authenticate the CLI";
      this.ws.send(JSON.stringify({
        type: "error",
        message: `${name} on this machine isn't authenticated. On the machine, run \`${login}\`, then resend.`,
      }));
    }

    // Finalize once and reuse for the exit frame, local persistence, and push.
    const summary = finalizeRunSummary(this.run, exitCode);
    this.ws.send(JSON.stringify({ type: "exit", code: exitCode, summary }));

    // Persist the run locally (daemon-only) for usage aggregates. Best-effort.
    recordRun(
      { id: crypto.randomUUID(), sessionId: this.data.id, cli: this.data.cli, project: this.data.project },
      summary,
      new Date(),
    );

    // Only push if the WebSocket has since closed — if it's still open the app
    // is in the foreground and already received the exit message directly.
    const wsStillOpen = (this.ws as any).readyState === 1;
    if (pushToken && exitCode === 0 && !wsStillOpen) {
      const project = this.data.project.split("/").pop() ?? this.data.project;
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
