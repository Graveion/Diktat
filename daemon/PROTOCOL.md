# Diktat Daemon – Protocol Reference

This document is the authoritative API contract for the Diktat daemon. It covers every data format the daemon touches, from upstream CLI output through to the WebSocket messages exchanged with the iOS app.

---

## 1. Cursor Composer blob format (store.db)

**Upstream source of truth. The daemon does NOT read store.db directly.**

Cursor stores conversation history in `~/.cursor/projects/<encoded-path>/store.db`. The daemon reads the agent-transcript JSONL files instead (see §4). This section documents the raw blob format for reference and for understanding what the JSONL files are derived from.

### Assistant message blob

```json
{
  "role": "assistant",
  "content": [
    {
      "type": "redacted-reasoning",
      "data": "<base64-encoded reasoning>",
      "providerOptions": { "cursor": { "modelName": "composer-2.5-fast" } }
    },
    { "type": "text", "text": "Actual assistant response text\n" },
    {
      "type": "tool-call",
      "toolCallId": "tool_abc123",
      "toolName": "Shell",
      "args": { "command": "git status", "description": "Check git status" }
    },
    {
      "type": "tool-call",
      "toolCallId": "tool_def456",
      "toolName": "Glob",
      "args": { "glob_pattern": "**/*.swift" }
    }
  ],
  "id": "1"
}
```

Key points:
- `type: "redacted-reasoning"` blocks contain base64-encoded internal reasoning; they must be ignored/stripped.
- Tool invocations use `type: "tool-call"` (hyphen) and `toolCallId`/`toolName` (camelCase).
- This differs from the Anthropic format used in Claude's JSONL (`type: "tool_use"`, `id`, `name` — underscores).

### User message blob

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool-result",
      "toolCallId": "tool_abc123",
      "toolName": "Shell",
      "result": "output text",
      "experimental_content": [{ "type": "text", "text": "output text" }]
    },
    {
      "type": "text",
      "text": "<user_query>\nActual user message\n</user_query>"
    }
  ],
  "providerOptions": { "cursor": { "requestId": "uuid" } }
}
```

Key points:
- Tool results use `type: "tool-result"` (hyphen) with `toolCallId`/`toolName`.
- The actual user query is wrapped in `<user_query>` tags and sometimes preceded by a `<timestamp>` tag. These wrappers must be stripped when displaying the message.

---

## 2. Cursor CLI stream-json format

**What `parseCursorChunk` actually parses** — streamed from `agent --output-format stream-json --stream-partial-output`.

Each line is a self-contained JSON object (NDJSON). The daemon reads stdout and splits on newlines.

### Text delta

Emitted while the assistant is generating text. Multiple deltas arrive per response.

```json
{
  "type": "assistant",
  "timestamp_ms": 1710000000000,
  "message": {
    "content": [
      { "type": "text", "text": "partial text fragment" }
    ]
  }
}
```

Distinguishing feature: `timestamp_ms` is present AND `model_call_id` is absent. The daemon strips `[redacted]` markers from `text` before forwarding.

### Tool call started

```json
{
  "type": "tool_call",
  "subtype": "started",
  "call_id": "uuid",
  "tool_call": {
    "readToolCall": {
      "args": { "path": "/some/file.ts" },
      "result": null
    }
  }
}
```

Known tool wrappers: `readToolCall`, `writeToolCall`, `editToolCall`, `bashToolCall`, `searchToolCall`, `webToolCall`.

### Tool call completed

```json
{
  "type": "tool_call",
  "subtype": "completed",
  "call_id": "uuid",
  "tool_call": {
    "readToolCall": {
      "args": { "path": "/some/file.ts" },
      "result": {
        "success": { "content": "file contents here" }
      }
    }
  }
}
```

The `result.success` shape varies by tool type (see `extractCursorResultText` in `session.ts`).

### Session ID capture

```json
{ "session_id": "uuid" }
```

May appear on any line; the daemon captures it on first occurrence and saves it to `SessionData.cliSessionId`.

---

## 3. Claude CLI stream-json format

**What `parseClaudeChunk` parses** — streamed from `claude -p <text> --output-format stream-json --verbose`.

Each line is NDJSON.

### Session ID line

```json
{ "session_id": "uuid" }
```

Captured on first occurrence; persisted to `SessionData.cliSessionId` for `--resume` on subsequent turns.

### Assistant text / tool use

```json
{
  "type": "assistant",
  "message": {
    "content": [
      { "type": "text", "text": "Response text" },
      {
        "type": "tool_use",
        "id": "toolu_abc123",
        "name": "Read",
        "input": { "file_path": "/path/to/file" }
      }
    ]
  }
}
```

- Text blocks → forwarded as `output` messages.
- `tool_use` blocks (underscore) → forwarded as `tool_use` messages with optional preview fields.

### Tool result (user turn)

```json
{
  "type": "user",
  "message": {
    "content": [
      {
        "type": "tool_result",
        "tool_use_id": "toolu_abc123",
        "content": "tool output text or array of content blocks"
      }
    ]
  }
}
```

Forwarded as `tool_result` messages with a truncated preview.

### Error / plain text

Non-JSON lines are forwarded as `output` messages, except lines matching `/no conversation found/i` which trigger a retry without `--resume` (stale session ID recovery).

---

## 4. Agent-transcript JSONL format

**The persistent conversation history files** read by `readCursorHistory` and `readHistory` (Claude).

Files live at:
- **Cursor**: `~/.cursor/projects/<encoded-path>/agent-transcripts/<session-id>/<session-id>.jsonl`
- **Claude**: `~/.claude/projects/<encoded-path>/<session-id>.jsonl`

### Cursor JSONL — assistant entry

```json
{
  "role": "assistant",
  "content": [
    { "type": "redacted-reasoning", "data": "<base64>", "providerOptions": { "cursor": { "modelName": "..." } } },
    { "type": "text", "text": "Response text\n" },
    { "type": "tool_use", "id": "tool_abc123", "name": "Read", "input": { "file_path": "/path" } }
  ],
  "id": "1"
}
```

Or with a `message` wrapper:

```json
{ "role": "assistant", "message": { "content": [...] } }
```

The daemon uses `entry.message?.content ?? entry.content` to handle both shapes.

`redacted-reasoning` blocks are silently skipped (only `type === "text"` and `type === "tool_use"` are processed).

### Cursor JSONL — user entry

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "tool_abc123",
      "content": "tool output text"
    },
    {
      "type": "text",
      "text": "<user_query>\nUser message\n</user_query>"
    }
  ],
  "providerOptions": { "cursor": { "requestId": "uuid" } }
}
```

### Claude JSONL — user entry

```json
{
  "type": "user",
  "cwd": "/path/to/project",
  "message": { "content": "User message text" }
}
```

`content` may also be an array of blocks (tool results + text).

### Claude JSONL — assistant entry

```json
{
  "type": "assistant",
  "message": {
    "content": [
      { "type": "text", "text": "Response" },
      { "type": "tool_use", "id": "toolu_x", "name": "Bash", "input": { "command": "ls" } }
    ]
  }
}
```

---

## 5. Daemon ↔ App WebSocket protocol

The daemon binds on its Tailscale IP and the configured port. The app connects via WebSocket. All messages are JSON strings.

### App → Daemon (inbound)

#### `spawn` — create a new session

```json
{
  "type": "spawn",
  "cli": "claude",
  "project": "/abs/path/to/project",
  "mode": "auto"
}
```

- `cli`: `"claude"` or `"cursor"`.
- `project`: Must be in the daemon's `config.projects` allowlist.
- `mode`: Optional. Passed through to Cursor as `--mode`.

Response: `spawned`

#### `resume` — attach to an existing session

```json
{
  "type": "resume",
  "sessionId": "uuid",
  "project": "/abs/path/to/project",
  "isClaudeSession": true,
  "isCursorSession": false
}
```

- `isClaudeSession`: Resume a raw Claude CLI session (from `claudeSessions` list).
- `isCursorSession`: Resume a raw Cursor CLI session (from `cursorSessions` list).
- Neither flag: Resume a daemon-tracked session by its daemon ID.

Response: `resumed`, then async `history`.

#### `input` — send text to the active session

```json
{
  "type": "input",
  "sessionId": "uuid",
  "text": "user message here"
}
```

The session runs the appropriate CLI and streams responses back as `output`, `tool_use`, `tool_result`, and `exit` messages.

#### `cancel` — kill the running process

```json
{
  "type": "cancel",
  "sessionId": "uuid"
}
```

Response: `exit` with `code: -1`.

#### `register_push` — register APNs push token

```json
{
  "type": "register_push",
  "token": "<apns-device-token>"
}
```

No response. When a session completes while the WebSocket is closed, a push notification is sent to this token.

#### `ping`

```json
{ "type": "ping" }
```

Response: `pong`.

---

### Daemon → App (outbound)

#### `connected` — sent immediately on WebSocket open

```json
{
  "type": "connected",
  "clis": ["claude", "cursor"],
  "projects": ["/abs/path/to/project"],
  "sessions": [
    {
      "id": "daemon-uuid",
      "cli": "claude",
      "project": "/path",
      "cliSessionId": "claude-session-uuid",
      "lastActiveAt": "2024-01-01T00:00:00.000Z"
    }
  ],
  "claudeSessions": [
    {
      "id": "claude-session-uuid",
      "project": "/path",
      "projectLabel": "myproject",
      "firstMessage": "First 120 chars of first message",
      "lastActiveAt": "2024-01-01T00:00:00.000Z"
    }
  ],
  "cursorSessions": [
    {
      "id": "cursor-session-uuid",
      "project": "/path",
      "projectLabel": "myproject",
      "firstMessage": "First 120 chars of first message",
      "lastActiveAt": "2024-01-01T00:00:00.000Z"
    }
  ]
}
```

#### `spawned` — session created

```json
{
  "type": "spawned",
  "session": {
    "id": "daemon-uuid",
    "cli": "claude",
    "project": "/path",
    "cliSessionId": null,
    "lastActiveAt": "2024-01-01T00:00:00.000Z"
  }
}
```

#### `resumed` — session resumed

```json
{
  "type": "resumed",
  "session": {
    "id": "daemon-uuid",
    "cli": "cursor",
    "project": "/path",
    "cliSessionId": "cursor-session-uuid",
    "lastActiveAt": "2024-01-01T00:00:00.000Z"
  }
}
```

#### `history` — full conversation history (async, after `resumed`)

```json
{
  "type": "history",
  "messages": [
    { "role": "user", "text": "user message" },
    { "role": "assistant", "text": "assistant response" },
    {
      "role": "tool",
      "text": "",
      "toolName": "Read:file.ts",
      "toolPath": "/path/to/file.ts",
      "toolId": "tool_abc123",
      "toolDiff": "- old line\n+ new line",
      "toolPreview": "file content preview",
      "toolCommand": "bash command",
      "toolResult": "tool output preview",
      "toolTruncated": false,
      "toolResultTruncated": false,
      "toolFullSize": 1234
    }
  ]
}
```

All fields on tool messages except `role`, `text`, and `toolName` are optional and only present when applicable.

#### `output` — streaming text from the assistant

```json
{ "type": "output", "text": "partial or complete text fragment" }
```

For Cursor, `[redacted]` markers are stripped before forwarding. Empty strings are never sent.

#### `tool_use` — tool invocation in progress

```json
{
  "type": "tool_use",
  "id": "tool-id-or-call-id",
  "name": "Read",
  "path": "/path/to/file.ts",
  "diff": "- old\n+ new",
  "preview": "content preview",
  "command": "bash command",
  "truncated": true,
  "fullSize": 4096
}
```

- `id`: Present for Claude tool uses (`tool_use_id`). For Cursor, the `call_id` UUID.
- `path`: Present for file tools (Read, Write, Edit).
- `diff`: Present for Edit/MultiEdit.
- `preview`: Present for Write.
- `command`: Present for Bash/Grep/WebFetch.
- `truncated`, `fullSize`: Present when content was truncated.

#### `tool_result` — result of a completed tool call

```json
{
  "type": "tool_result",
  "toolUseId": "tool-id-or-call-id",
  "preview": "truncated result text",
  "truncated": false,
  "fullSize": 256
}
```

Not sent if the result text is empty or matches the "file has been updated/created" boilerplate.

#### `exit` — session process exited

```json
{ "type": "exit", "code": 0 }
```

`code: -1` means the session was cancelled. If the WebSocket is already closed at exit time and a push token is registered, a push notification is also sent.

The completion push summarizes what the agent actually did during the run (derived from the parsed tool stream — see `run-summary.ts`), not the user's prompt.

- **title**: `✓ {project}` on success, `✗ {project} — exited {code}` on non-zero exit (`{project}` is the path basename).
- **body**: compact, worst-news-first. Examples:
  - `3 files · +84/−12 · tests ✓ 41 passed · 1m20s`
  - `tests ✗ 2 failed · 3 files · +84/−12 · 1m20s`
  - `No file changes · 45s`
- **data**: `{ sessionId, exitCode, filesChanged: string[], editCount, linesAdded, linesRemoved, commandsRun, lastCommand?, testStatus: "pass"|"fail"|"none", testDetail?, durationMs }`. The deep-link `sessionId` is always present; `lastCommand`/`testDetail` are omitted when absent.

#### `error` — error from the daemon

```json
{ "type": "error", "message": "Human-readable error description" }
```

Sent for: unknown CLI, project not in allowlist, session not found, invalid message format, internal errors.

#### `pong` — response to ping

```json
{ "type": "pong" }
```
