import { test, expect, beforeEach } from "bun:test";
import { Session } from "./session";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockWs = () => {
  const sent: any[] = [];
  return {
    ws: {
      send: (msg: string) => sent.push(JSON.parse(msg)),
      readyState: 1,
    } as any,
    sent,
  };
};

/** Build a Session wired to the mock ws, backed by a stable fake cliSessionId. */
function makeSession(ws: any, cliSessionId?: string) {
  return Session.fromCursorSession(
    ws,
    cliSessionId ?? "cursor-session-id",
    "/tmp/fake-project",
    "agent",
  );
}

function makeClaudeSession(ws: any, cliSessionId?: string) {
  return Session.fromClaudeSession(
    ws,
    cliSessionId ?? "claude-session-id",
    "/tmp/fake-project",
    "claude",
  );
}

// Feed a JSON line (or multiple lines) into the session as if it came from
// the Cursor CLI stdout. We call the public `send()` method only when we want
// to spawn a real process; for unit tests we need a lighter path.
//
// Because parseCursorChunk is private, we drive it indirectly via a
// subprocess that just echoes JSON. But that's too heavy. Instead we patch the
// session at runtime using the fact that TypeScript private is compile-time only.
function feedCursorLines(session: Session, ...lines: any[]) {
  const chunk = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  (session as any).parseCursorChunk(chunk);
}

function feedClaudeLines(session: Session, ...lines: any[]) {
  const chunk = lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n";
  return (session as any).parseClaudeChunk(chunk);
}

// ---------------------------------------------------------------------------
// applyOptions (per-turn model / permission overrides)
// ---------------------------------------------------------------------------

test("applyOptions: persists model + permissionMode into session data", () => {
  const { ws } = mockWs();
  const session = makeClaudeSession(ws);
  session.applyOptions({ model: "opus", permissionMode: "full" });
  const data = (session as any).data;
  expect(data.model).toBe("opus");
  expect(data.permissionMode).toBe("full");
});

test("applyOptions: empty model string clears the override (back to default)", () => {
  const { ws } = mockWs();
  const session = makeClaudeSession(ws);
  session.applyOptions({ model: "opus" });
  session.applyOptions({ model: "" });
  expect((session as any).data.model).toBeUndefined();
});

// ---------------------------------------------------------------------------
// parseCursorChunk tests
// ---------------------------------------------------------------------------

test("parseCursorChunk: text delta forwarded correctly", () => {
  const { ws, sent } = mockWs();
  const session = makeSession(ws);

  feedCursorLines(session, {
    type: "assistant",
    timestamp_ms: 1000,
    message: { content: [{ type: "text", text: "Hello world" }] },
  });

  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ type: "output", text: "Hello world" });
});

test("parseCursorChunk: [redacted] stripped from text before send", () => {
  const { ws, sent } = mockWs();
  const session = makeSession(ws);

  feedCursorLines(session, {
    type: "assistant",
    timestamp_ms: 1000,
    message: {
      content: [{ type: "text", text: "Before[redacted] after" }],
    },
  });

  expect(sent).toHaveLength(1);
  expect(sent[0].text).toBe("Before after");
});

test("parseCursorChunk: pure [redacted] text → nothing sent", () => {
  const { ws, sent } = mockWs();
  const session = makeSession(ws);

  feedCursorLines(session, {
    type: "assistant",
    timestamp_ms: 1000,
    message: { content: [{ type: "text", text: "[redacted]" }] },
  });

  // After stripping "[redacted]" the text is empty → must not send
  const outputMessages = sent.filter((m) => m.type === "output");
  expect(outputMessages).toHaveLength(0);
});

test("parseCursorChunk: redacted-reasoning blocks in content → nothing sent", () => {
  const { ws, sent } = mockWs();
  const session = makeSession(ws);

  // An assistant message that contains only a redacted-reasoning block
  feedCursorLines(session, {
    type: "assistant",
    timestamp_ms: 1000,
    message: {
      content: [
        {
          type: "redacted-reasoning",
          data: "base64data==",
          providerOptions: { cursor: { modelName: "composer-2.5-fast" } },
        },
      ],
    },
  });

  // Only type === "text" blocks should be forwarded
  const outputMessages = sent.filter((m) => m.type === "output");
  expect(outputMessages).toHaveLength(0);
});

test("parseCursorChunk: tool_call started → tool_use message sent", () => {
  const { ws, sent } = mockWs();
  const session = makeSession(ws);

  feedCursorLines(session, {
    type: "tool_call",
    subtype: "started",
    call_id: "call-001",
    tool_call: {
      readToolCall: {
        args: { path: "/src/index.ts" },
        result: null,
      },
    },
  });

  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    type: "tool_use",
    id: "call-001",
    name: "Read",
    path: "/src/index.ts",
  });
});

test("parseCursorChunk: tool_call completed → tool_result message sent", () => {
  const { ws, sent } = mockWs();
  const session = makeSession(ws);

  feedCursorLines(session, {
    type: "tool_call",
    subtype: "completed",
    call_id: "call-001",
    tool_call: {
      readToolCall: {
        args: { path: "/src/index.ts" },
        result: {
          success: { content: "export default function main() {}" },
        },
      },
    },
  });

  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    type: "tool_result",
    toolUseId: "call-001",
  });
  expect(typeof sent[0].preview).toBe("string");
  expect(sent[0].preview.length).toBeGreaterThan(0);
});

test("parseCursorChunk: session_id captured on first occurrence", () => {
  const { ws } = mockWs();
  // Start with no cliSessionId
  const session = Session.fromCursorSession(ws, "", "/tmp/fake-project", "agent");

  feedCursorLines(session, { session_id: "new-cursor-session" });

  // The summary should expose the captured session ID
  expect(session.summary.cliSessionId).toBe("new-cursor-session");
});

// ---------------------------------------------------------------------------
// parseClaudeChunk tests
// ---------------------------------------------------------------------------

test("parseClaudeChunk: text block forwarded", () => {
  const { ws, sent } = mockWs();
  const session = makeClaudeSession(ws);

  feedClaudeLines(session, {
    type: "assistant",
    message: {
      content: [{ type: "text", text: "Claude response" }],
    },
  });

  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ type: "output", text: "Claude response" });
});

test("parseClaudeChunk: tool_use forwarded with correct shape", () => {
  const { ws, sent } = mockWs();
  const session = makeClaudeSession(ws);

  feedClaudeLines(session, {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "toolu_abc",
          name: "Read",
          input: { file_path: "/some/file.ts" },
        },
      ],
    },
  });

  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    type: "tool_use",
    id: "toolu_abc",
    name: "Read",
    path: "/some/file.ts",
  });
});

test("parseClaudeChunk: 'no conversation found' returns true (retry signal)", () => {
  const { ws } = mockWs();
  const session = makeClaudeSession(ws);

  const needsRetry = feedClaudeLines(session, "Error: no conversation found");

  expect(needsRetry).toBe(true);
});

test("parseClaudeChunk: 'no conversation found' is case-insensitive", () => {
  const { ws } = mockWs();
  const session = makeClaudeSession(ws);

  const needsRetry = feedClaudeLines(session, "No Conversation Found in history");

  expect(needsRetry).toBe(true);
});

test("parseClaudeChunk: normal non-JSON line does not return retry", () => {
  const { ws, sent } = mockWs();
  const session = makeClaudeSession(ws);

  const needsRetry = feedClaudeLines(session, "Some plain output line");

  expect(needsRetry).toBe(false);
  // Plain text lines are forwarded as output
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ type: "output", text: "Some plain output line" });
});

test("parseClaudeChunk: tool_result patch forwarded", () => {
  const { ws, sent } = mockWs();
  const session = makeClaudeSession(ws);

  feedClaudeLines(session, {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_abc",
          content: "ls output line 1\nls output line 2",
        },
      ],
    },
  });

  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    type: "tool_result",
    toolUseId: "toolu_abc",
  });
  expect(typeof sent[0].preview).toBe("string");
});

test("parseClaudeChunk: tool_result with boilerplate suppressed", () => {
  const { ws, sent } = mockWs();
  const session = makeClaudeSession(ws);

  feedClaudeLines(session, {
    type: "user",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_xyz",
          content: "The file /foo/bar.ts has been updated successfully.",
        },
      ],
    },
  });

  // buildToolResultPreview returns null for this boilerplate → nothing sent
  const toolResults = sent.filter((m) => m.type === "tool_result");
  expect(toolResults).toHaveLength(0);
});

test("parseClaudeChunk: session_id captured from stream", () => {
  const { ws } = mockWs();
  const session = Session.fromClaudeSession(ws, "", "/tmp/fake-project", "claude");

  feedClaudeLines(session, { session_id: "captured-claude-session" });

  expect(session.summary.cliSessionId).toBe("captured-claude-session");
});

test("parseClaudeChunk: mixed text and tool_use in one message", () => {
  const { ws, sent } = mockWs();
  const session = makeClaudeSession(ws);

  feedClaudeLines(session, {
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Let me check:" },
        {
          type: "tool_use",
          id: "toolu_123",
          name: "Bash",
          input: { command: "ls -la" },
        },
      ],
    },
  });

  expect(sent).toHaveLength(2);
  expect(sent[0]).toMatchObject({ type: "output", text: "Let me check:" });
  expect(sent[1]).toMatchObject({ type: "tool_use", name: "Bash", command: "ls -la" });
});

// ---------------------------------------------------------------------------
// parseCursorChunk — Bash/Write tool edge cases
// ---------------------------------------------------------------------------

test("parseCursorChunk: bashToolCall started includes command preview", () => {
  const { ws, sent } = mockWs();
  const session = makeSession(ws);

  feedCursorLines(session, {
    type: "tool_call",
    subtype: "started",
    call_id: "call-bash",
    tool_call: {
      bashToolCall: {
        args: { command: "npm test" },
        result: null,
      },
    },
  });

  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    type: "tool_use",
    id: "call-bash",
    name: "Bash",
    command: "npm test",
  });
});

test("parseCursorChunk: unknown tool_call wrapper → nothing sent", () => {
  const { ws, sent } = mockWs();
  const session = makeSession(ws);

  feedCursorLines(session, {
    type: "tool_call",
    subtype: "started",
    call_id: "call-unknown",
    tool_call: {
      unknownFutureTool: { args: {}, result: null },
    },
  });

  expect(sent).toHaveLength(0);
});

test("parseCursorChunk: malformed JSON line silently ignored", () => {
  const { ws, sent } = mockWs();
  const session = makeSession(ws);

  // Feed a valid line followed by corrupt JSON
  (session as any).parseCursorChunk(
    '{"type":"assistant","timestamp_ms":1,"message":{"content":[{"type":"text","text":"ok"}]}}\n{broken json\n',
  );

  // Only the valid line should have produced output
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ type: "output", text: "ok" });
});

test("parseCursorChunk: model_call_id present → not a delta, not forwarded as output", () => {
  const { ws, sent } = mockWs();
  const session = makeSession(ws);

  // When model_call_id is set, parseCursorChunk must NOT treat it as a streaming delta
  feedCursorLines(session, {
    type: "assistant",
    timestamp_ms: 1000,
    model_call_id: "mc_123",
    message: { content: [{ type: "text", text: "should not be forwarded" }] },
  });

  const outputMessages = sent.filter((m) => m.type === "output");
  expect(outputMessages).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Fixture-derived tests — real tool inputs extracted from cursor-session.jsonl
// These use the SAME tool names + input shapes as the real Cursor CLI output.
// Note: the live Cursor stream format uses tool_call events (not tool_use),
// so we synthesise stream events that match parseCursorChunk's expectations.
// ---------------------------------------------------------------------------

test("fixture: real Read tool path surfaces in tool_use message", () => {
  const { ws, sent } = mockWs();
  const session = makeSession(ws);

  // Synthesise a cursor stream tool_call/started with a real path from the logs
  const chunk = JSON.stringify({
    type: "tool_call",
    subtype: "started",
    call_id: "real-read-1",
    tool_call: {
      readToolCall: {
        args: { path: "/Users/timothygreen/Documents/Pacer/WhatsMyPace/Dependencies/Sync/ProfileClient/InboundProfileApply.swift" },
        result: null,
      },
    },
  });

  (session as any).parseCursorChunk(chunk);

  const msg = sent.find((m) => m.type === "tool_use");
  expect(msg).toBeDefined();
  expect(msg.name).toBe("Read");
  expect(msg.path).toContain("InboundProfileApply.swift");
});

test("fixture: real StrReplace (→ Edit) tool_call with path", () => {
  const { ws, sent } = mockWs();
  const session = makeSession(ws);

  const chunk = JSON.stringify({
    type: "tool_call",
    subtype: "started",
    call_id: "real-edit-1",
    tool_call: {
      editToolCall: {
        args: {
          path: "/Users/timothygreen/Documents/Pacer/PacerPackage/Sources/SyncFeature/AvatarSyncMetadata.swift",
          oldString: "let old = 1",
          newString: "let new = 2",
        },
        result: null,
      },
    },
  });

  (session as any).parseCursorChunk(chunk);

  const msg = sent.find((m) => m.type === "tool_use");
  expect(msg).toBeDefined();
  expect(msg.name).toBe("Edit");
  expect(msg.path).toContain("AvatarSyncMetadata.swift");
});

test("fixture: real Shell command (swift build) forwarded correctly", () => {
  const { ws, sent } = mockWs();
  const session = makeSession(ws);

  const chunk = JSON.stringify({
    type: "tool_call",
    subtype: "started",
    call_id: "real-shell-1",
    tool_call: {
      bashToolCall: {
        args: { command: "swift build --package-path PacerPackage" },
        result: null,
      },
    },
  });

  (session as any).parseCursorChunk(chunk);

  const msg = sent.find((m) => m.type === "tool_use");
  expect(msg).toBeDefined();
  expect(msg.name).toBe("Bash");
  expect(msg.command).toContain("swift build");
});

test("fixture: real Grep tool_call forwarded correctly", () => {
  const { ws, sent } = mockWs();
  const session = makeSession(ws);

  const chunk = JSON.stringify({
    type: "tool_call",
    subtype: "started",
    call_id: "real-grep-1",
    tool_call: {
      searchToolCall: {
        args: { pattern: "reportIssue", glob: "*.swift" },
        result: null,
      },
    },
  });

  (session as any).parseCursorChunk(chunk);

  const msg = sent.find((m) => m.type === "tool_use");
  expect(msg).toBeDefined();
  expect(msg.name).toBe("Grep");
});

test("fixture: tool_call completed with real Write result surfaces in tool_result", () => {
  const { ws, sent } = mockWs();
  const session = makeSession(ws);

  // started first so call_id is registered
  (session as any).parseCursorChunk(JSON.stringify({
    type: "tool_call", subtype: "started", call_id: "real-write-1",
    tool_call: { writeToolCall: { args: { path: "/src/AvatarSyncMetadata.swift", fileText: "..." }, result: null } },
  }));

  // completed with realistic success payload
  (session as any).parseCursorChunk(JSON.stringify({
    type: "tool_call", subtype: "completed", call_id: "real-write-1",
    tool_call: {
      writeToolCall: {
        args: { path: "/src/AvatarSyncMetadata.swift", fileText: "..." },
        result: { success: { path: "/src/AvatarSyncMetadata.swift", linesCreated: 42, fileSize: 1280 } },
      },
    },
  }));

  const result = sent.find((m) => m.type === "tool_result");
  expect(result).toBeDefined();
  expect(result.toolUseId).toBe("real-write-1");
  expect(result.preview).toContain("AvatarSyncMetadata.swift");
});

// ---------------------------------------------------------------------------
// extractCursorResultText — private method, exercised via (session as any)
// ---------------------------------------------------------------------------

test("extractCursorResultText: Read with string content → content", () => {
  const { ws } = mockWs();
  const session = makeSession(ws);
  expect((session as any).extractCursorResultText("Read", { content: "abc" })).toBe("abc");
});

test("extractCursorResultText: Read with non-string content → null", () => {
  const { ws } = mockWs();
  const session = makeSession(ws);
  expect((session as any).extractCursorResultText("Read", { content: 123 })).toBeNull();
});

test("extractCursorResultText: Write builds 'Wrote X · N lines · M bytes'", () => {
  const { ws } = mockWs();
  const session = makeSession(ws);
  expect(
    (session as any).extractCursorResultText("Write", { path: "/x", linesCreated: 42, fileSize: 1280 }),
  ).toBe("Wrote /x · 42 lines · 1280 bytes");
});

test("extractCursorResultText: Write with empty success → null", () => {
  const { ws } = mockWs();
  const session = makeSession(ws);
  expect((session as any).extractCursorResultText("Write", {})).toBeNull();
});

test("extractCursorResultText: default with stdout+stderr → 'out\\n[stderr]\\nerr'", () => {
  const { ws } = mockWs();
  const session = makeSession(ws);
  expect(
    (session as any).extractCursorResultText("Bash", { stdout: "out", stderr: "err" }),
  ).toBe("out\n[stderr]\nerr");
});

test("extractCursorResultText: default with only stdout → stdout", () => {
  const { ws } = mockWs();
  const session = makeSession(ws);
  expect((session as any).extractCursorResultText("Bash", { stdout: "out" })).toBe("out");
});

test("extractCursorResultText: default with output field → output", () => {
  const { ws } = mockWs();
  const session = makeSession(ws);
  expect((session as any).extractCursorResultText("Bash", { output: "o" })).toBe("o");
});

test("extractCursorResultText: null / non-object → null", () => {
  const { ws } = mockWs();
  const session = makeSession(ws);
  expect((session as any).extractCursorResultText("Read", null)).toBeNull();
  expect((session as any).extractCursorResultText("Read", "not an object")).toBeNull();
  expect((session as any).extractCursorResultText("Bash", undefined)).toBeNull();
});

test("fixture: [REDACTED] in cursor stream text is stripped before forwarding", () => {
  const { ws, sent } = mockWs();
  const session = makeSession(ws);

  // Pattern from real logs: real reasoning text with [REDACTED] appended
  const chunk = JSON.stringify({
    type: "assistant",
    timestamp_ms: Date.now(),
    message: {
      content: [{
        type: "text",
        text: "I've confirmed measurements inbound apply is still stubbed in InboundSyncRouter.\n\n[REDACTED]",
      }],
    },
  });

  (session as any).parseCursorChunk(chunk);

  const output = sent.find((m) => m.type === "output");
  expect(output).toBeDefined();
  expect(output.text).not.toContain("[REDACTED]");
  expect(output.text).toContain("InboundSyncRouter");
});
