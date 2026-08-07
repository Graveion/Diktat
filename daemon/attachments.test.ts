import { test, expect } from "bun:test";
import { existsSync } from "fs";
import {
  Session,
  parseAttachments,
  attachmentExtension,
  buildImagePrompt,
  MAX_ATTACHMENTS,
  type InputAttachment,
} from "./session";
import { agentSupportsImages } from "./agents";

const mockWs = () => {
  const sent: any[] = [];
  return {
    ws: { send: (msg: string) => sent.push(JSON.parse(msg)), readyState: 1 } as any,
    sent,
  };
};

// ---------------------------------------------------------------------------
// Capability gating
// ---------------------------------------------------------------------------

test("agentSupportsImages: only Claude Code today", () => {
  expect(agentSupportsImages("claude")).toBe(true);
  for (const cli of ["cursor", "copilot", "kiro", "codex", "unknown"]) {
    expect(agentSupportsImages(cli)).toBe(false);
  }
});

// ---------------------------------------------------------------------------
// parseAttachments — validation / normalization
// ---------------------------------------------------------------------------

test("parseAttachments: keeps valid http(s) entries and normalizes name", () => {
  const out = parseAttachments([
    { url: "https://example.com/a.png", mime: "image/png", name: "a.png" },
    { url: "http://example.com/b.jpg", mime: "image/jpeg" },
  ]);
  expect(out).toEqual([
    { url: "https://example.com/a.png", mime: "image/png", name: "a.png" },
    { url: "http://example.com/b.jpg", mime: "image/jpeg" },
  ]);
});

test("parseAttachments: rejects non-array, missing/invalid fields, and non-http schemes", () => {
  expect(parseAttachments(undefined)).toEqual([]);
  expect(parseAttachments("nope")).toEqual([]);
  expect(
    parseAttachments([
      null,
      42,
      { url: "https://ok.com/x.png" }, // no mime
      { mime: "image/png" }, // no url
      { url: "file:///etc/passwd", mime: "image/png" }, // scheme not allowed
      { url: "data:image/png;base64,AAAA", mime: "image/png" }, // scheme not allowed
      { url: "ftp://host/x.png", mime: "image/png" }, // scheme not allowed
    ]),
  ).toEqual([]);
});

test("parseAttachments: caps at MAX_ATTACHMENTS", () => {
  const many = Array.from({ length: MAX_ATTACHMENTS + 5 }, (_, i) => ({
    url: `https://example.com/${i}.png`,
    mime: "image/png",
  }));
  expect(parseAttachments(many)).toHaveLength(MAX_ATTACHMENTS);
});

// ---------------------------------------------------------------------------
// attachmentExtension — mime first, then filename fallback
// ---------------------------------------------------------------------------

test("attachmentExtension: derives from mime", () => {
  expect(attachmentExtension({ url: "u", mime: "image/png" })).toBe("png");
  expect(attachmentExtension({ url: "u", mime: "image/jpeg" })).toBe("jpg");
  expect(attachmentExtension({ url: "u", mime: "image/webp" })).toBe("webp");
});

test("attachmentExtension: falls back to filename extension then a default", () => {
  expect(attachmentExtension({ url: "u", mime: "application/octet-stream", name: "shot.HEIC" })).toBe("heic");
  expect(attachmentExtension({ url: "u", mime: "application/octet-stream" })).toBe("img");
});

// ---------------------------------------------------------------------------
// buildImagePrompt — prompt injection format
// ---------------------------------------------------------------------------

test("buildImagePrompt: no paths → original text unchanged", () => {
  expect(buildImagePrompt("hello", [])).toBe("hello");
});

test("buildImagePrompt: appends single path with singular wording", () => {
  const out = buildImagePrompt("describe this", ["/tmp/x/a.png"]);
  expect(out).toBe("describe this\n\nAttached image (local file path):\n/tmp/x/a.png");
});

test("buildImagePrompt: appends multiple paths with plural wording", () => {
  const out = buildImagePrompt("compare", ["/tmp/x/a.png", "/tmp/x/b.jpg"]);
  expect(out).toContain("Attached images (local file paths):");
  expect(out).toContain("/tmp/x/a.png");
  expect(out).toContain("/tmp/x/b.jpg");
});

test("buildImagePrompt: empty text still lists the paths (no leading blank block)", () => {
  expect(buildImagePrompt("", ["/tmp/x/a.png"])).toBe("Attached image (local file path):\n/tmp/x/a.png");
});

// ---------------------------------------------------------------------------
// downloadAttachments + cleanupTemps — temp-file lifecycle
// ---------------------------------------------------------------------------

// A 1x1 transparent PNG, base64-encoded, served over a local HTTP server so we
// exercise the real fetch → arrayBuffer → Bun.write path without the network.
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

test("downloadAttachments writes temp files, cleanupTemps removes them", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () => new Response(PNG_1x1, { headers: { "content-type": "image/png" } }),
  });
  try {
    const { ws } = mockWs();
    const session = Session.fromClaudeSession(ws, "claude-attach-test", "/tmp/fake-project", "claude");
    const base = `http://localhost:${server.port}`;
    const attachments: InputAttachment[] = [
      { url: `${base}/a.png`, mime: "image/png", name: "a.png" },
      { url: `${base}/b.png`, mime: "image/png" },
    ];

    const paths: string[] = await (session as any).downloadAttachments(attachments);
    expect(paths).toHaveLength(2);
    for (const p of paths) {
      expect(existsSync(p)).toBe(true);
      expect(p.endsWith(".png")).toBe(true);
    }

    (session as any).cleanupTemps();
    for (const p of paths) expect(existsSync(p)).toBe(false);
  } finally {
    server.stop(true);
  }
});

test("downloadAttachments: a failed fetch is skipped, not fatal", async () => {
  const { ws } = mockWs();
  const session = Session.fromClaudeSession(ws, "claude-attach-fail", "/tmp/fake-project", "claude");
  // Unroutable port → fetch rejects; method must still resolve with []
  const paths: string[] = await (session as any).downloadAttachments([
    { url: "http://127.0.0.1:1/nope.png", mime: "image/png" },
  ]);
  expect(paths).toEqual([]);
  (session as any).cleanupTemps();
});
