import { test, expect } from "bun:test";
import { KNOWN_CLIS, AGENT_MODELS, PERMISSION_MODES, modelFlags, permissionFlags, agentSelectionData } from "./agents";

test("KNOWN_CLIS covers all five agents", () => {
  expect(Object.keys(KNOWN_CLIS).sort()).toEqual(["claude", "codex", "copilot", "cursor", "kiro"]);
  expect(KNOWN_CLIS.kiro).toBe("kiro-cli");
});

test("modelFlags: omits --model for empty/undefined, emits it otherwise", () => {
  expect(modelFlags(undefined)).toEqual([]);
  expect(modelFlags("")).toEqual([]);
  expect(modelFlags("opus")).toEqual(["--model", "opus"]);
});

test("permissionFlags: claude maps the 3 tiers to --permission-mode", () => {
  expect(permissionFlags("claude", "plan")).toEqual(["--permission-mode", "plan"]);
  expect(permissionFlags("claude", "auto")).toEqual(["--permission-mode", "acceptEdits"]);
  expect(permissionFlags("claude", "full")).toEqual(["--permission-mode", "bypassPermissions"]);
});

test("permissionFlags: codex maps to approval × sandbox (and bypass for full)", () => {
  expect(permissionFlags("codex", "plan")).toEqual(["--ask-for-approval", "never", "--sandbox", "read-only"]);
  expect(permissionFlags("codex", "auto")).toEqual(["--ask-for-approval", "never", "--sandbox", "workspace-write"]);
  expect(permissionFlags("codex", "full")).toEqual(["--dangerously-bypass-approvals-and-sandbox"]);
});

test("permissionFlags: cursor/copilot/kiro tiers", () => {
  expect(permissionFlags("cursor", "plan")).toEqual(["--mode", "plan"]);
  expect(permissionFlags("cursor", "auto")).toEqual(["--trust"]);
  expect(permissionFlags("cursor", "full")).toEqual(["--yolo", "--trust"]);
  expect(permissionFlags("copilot", "plan")).toEqual([]);
  expect(permissionFlags("copilot", "full")).toEqual(["--allow-all-tools"]);
  expect(permissionFlags("kiro", "plan")).toEqual(["--trust-tools="]);
  expect(permissionFlags("kiro", "auto")).toEqual(["--trust-all-tools"]);
});

test("agentSelectionData: every agent ships models + the 3 permission tiers", () => {
  const data = agentSelectionData();
  expect(Object.keys(data).sort()).toEqual(["claude", "codex", "copilot", "cursor", "kiro"]);
  for (const a of Object.values(data)) {
    expect(a.permissionModes).toEqual(PERMISSION_MODES);
    expect(a.models.length).toBeGreaterThan(0);
    expect(a.models[0]!.id).toBe(""); // first option is always the CLI default
  }
  expect(data.claude!.models.map((m) => m.id)).toEqual(["", "sonnet", "opus", "haiku"]);
  expect(AGENT_MODELS.claude!.length).toBe(4);
});
