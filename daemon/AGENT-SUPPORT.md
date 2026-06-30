# Expanding agent support — plan

## Verified CLI help output

### Cursor (`agent --help`) — verified 2026-06-20

```
Usage: agent [options] [command] [prompt...]

Start the Cursor Agent

Arguments:
  prompt                       Initial prompt for the agent

Options:
  -v, --version                Output the version number
  --api-key <key>              API key for authentication (can also use CURSOR_API_KEY env var)
  -H, --header <header>        Add custom header to agent requests (format: 'Name: Value', can be used multiple times)
  -p, --print                  Print responses to console (for scripts or non-interactive use). Has access to all tools, including write and shell. (default: false)
  --output-format <format>     Output format (only works with --print): text | json | stream-json (default: "text")
  --stream-partial-output      Stream partial output as individual text deltas (only works with --print and stream-json format) (default: false)
  --mode <mode>                Start in the given execution mode. plan: read-only/planning (analyze, propose plans, no edits). ask: Q&A style for explanations and questions
                               (read-only). (choices: "plan", "ask")
  --plan                       Start in plan mode (shorthand for --mode=plan). (default: false)
  --resume [chatId]            Select a session to resume (default: false)
  --continue                   Continue previous session (default: false)
  --model <model>              Model to use (e.g., gpt-5, sonnet-4-thinking). Parameterized models accept quoted bracket overrides, e.g.
                               'claude-opus-4-8[context=1m,effort=high,fast=false]'
  --list-models                List available models and exit (default: false)
  -f, --force                  Force allow commands unless explicitly denied (default: false)
  --yolo                       Alias for --force (Run Everything) (default: false)
  --sandbox <mode>             Explicitly enable or disable sandbox mode (overrides config) (choices: "enabled", "disabled")
  --approve-mcps               Automatically approve all MCP servers (default: false)
  --trust                      Trust the current workspace without prompting (only works with --print/headless mode) (default: false)
  --workspace <path>           Workspace directory to use (defaults to current working directory)
  --plugin-dir <path>          Load a local plugin directory (can be specified multiple times)
  -w, --worktree [name]        Start in an isolated git worktree at ~/.cursor/worktrees/<reponame>/<name>. If omitted, a name is generated.
  --worktree-base <branch>     Branch or ref to base the new worktree on (default: current HEAD)
  --skip-worktree-setup        Skip running worktree setup scripts from .cursor/worktrees.json (default: false)
  -h, --help                   Display help for command

Commands:
  install-shell-integration    Install shell integration to ~/.zshrc
  uninstall-shell-integration  Remove shell integration from ~/.zshrc
  login                        Authenticate with Cursor. Set NO_OPEN_BROWSER to disable browser opening.
  logout                       Sign out and clear stored authentication
  mcp                          Manage MCP servers
  worker [options]             Start a private cloud worker that connects to Cursor to run agents in your environment
  status|whoami [options]      View authentication status
  models                       List available models for this account
  about [options]              Display version, system, and account information
  update                       Update Cursor Agent to the latest version
  create-chat                  Create a new empty chat and return its ID
  generate-rule|rule           Generate a new Cursor rule with interactive prompts
  agent [prompt...]            Start the Cursor Agent
  ls                           Resume a chat session
  resume                       Resume the latest chat session
  help [command]               Display help for command
```

**Key facts:**
- `--mode` only accepts `plan` and `ask` — both are **read-only**. No `--mode` flag = full agent (write+shell).
- `-p` / `--print` enables headless mode (access to all tools including write and shell).
- `--trust` = trust workspace without prompting (only works with `--print`).
- `--force` / `--yolo` = force-allow all commands unless explicitly denied.
- Permission tier mapping: `plan` → `--mode plan` · `auto` → `--trust` · `full` → `--yolo --trust`

### GitHub Copilot (`copilot --help`) — verified 2026-06-30

```
Options (abridged to what Diktat uses; full help pasted in the PR/history):
  --effort, --reasoning-effort <level>  none | low | medium | high | xhigh | max
  --model <model>                       Set the AI model (use 'auto' to let Copilot pick). Example: gpt-5.2
  --mode <mode>                         interactive | plan | autopilot
  --plan                                Start in plan mode
  --allow-all-tools                     Allow all tools without confirmation; REQUIRED for non-interactive (-p) tool use (env: COPILOT_ALLOW_ALL)
  --allow-all                           = --allow-all-tools --allow-all-paths --allow-all-urls
  --yolo                                Alias for --allow-all
  --allow-tool / --deny-tool            Fine-grained tool allow/deny (e.g. 'shell(git:*)', 'write')
  --allow-url / --deny-url / --add-dir  Fine-grained network/path grants
  --output-format <format>             text (default) | json (JSONL, one object per line)
  -p, --prompt <text>                   Non-interactive mode (exits after completion)
  -s, --silent                          Output only the agent response (no stats)
  --session-id <id>                     Resume an existing session/task by ID, or set the UUID for a new session
  -r, --resume[=value] / --continue     Resume previous / most-recent session
  --no-remote / --remote                Copilot's OWN web/mobile remote control of the session
  --no-color                            Disable color
```

**Key facts:**
- `--model` is **open-ended** (`auto` = Copilot picks; example `gpt-5.2`). No model-list flag in help; available models are account/provider dependent (see the `providers` help topic for BYOK).
- New dimension we don't surface yet: **`--reasoning-effort`** (none…max).
- Permission flags: `--allow-all-tools` is **required** for headless tool use; `--allow-all`/`--yolo` additionally open all paths + URLs; fine-grained `--allow-tool`/`--deny-tool` exist.
- Output: `--output-format json` (JSONL) → structured events (parser still TODO; we run text + `--silent`).
- Resume: we own the UUID via `--session-id`.
- Revised permission tier mapping (from this help): `plan` → `--plan` (read-only, no tool exec) · `auto` → `--allow-all-tools` · `full` → `--allow-all`.
- **Docs (keep this block in sync):** https://docs.github.com/copilot/how-tos/copilot-cli

---

**Status:** planned · post-release task. Today Diktat supports **Claude Code**,
**Cursor**, **GitHub Copilot**, **Kiro**, and **Codex** (the last three text-mode
v1 — see notes below). This documents how to add more agentic coding CLIs cleanly.

> **Contract file:** `daemon/agents.ts` is the machine-readable source of truth
> for every supported CLI (binary, subcommand, prompt style, trust flags, output
> format, resume style, auth). Detection (`cli-detector.ts`) derives `KNOWN_CLIS`
> from it. Add a CLI there first, then implement its argv in `buildArgs`.

> **GitHub Copilot (added, text-mode v1):** wired via the same two seams
> (`KNOWN_CLIS` + `buildArgs`). It runs `copilot -p "<prompt>" --allow-all-tools
> --silent --no-color --session-id <uuid>` and forwards the plain response text
> verbatim (the existing `{type:"output"}` passthrough). We **own the session
> UUID** (`--session-id` both creates and resumes), so no session-id scraping.
> **History import is done** — read from `~/.copilot/session-store.db` via
> `bun:sqlite` (`copilot-sessions.ts`). What's still missing vs Claude/Cursor:
> **live rich tool previews** (diffs/results), which need Copilot's
> `--output-format json` JSONL event schema. **Follow-up:** capture one authed
> `--output-format json` sample, then add `parseCopilotChunk` to emit
> `tool_use`/`tool_result` events.

> **Kiro (added, text-mode v1):** the assistant is `kiro-cli chat`. We run
> `kiro-cli chat --no-interactive --trust-all-tools "<prompt>"` and forward the
> response text (ANSI stripped). Kiro has **no settable session id**, so we
> continue a conversation with `-r/--resume` (most recent in the project dir)
> after the first turn — tracked by `SessionData.started`. Chat output is plain
> text (the `-f json` flag is only for `--list-*`), so there are **no rich tool
> previews** yet. Auth is checked via `kiro-cli whoami` in `diktat setup`.
> **Follow-up:** if Kiro adds a structured chat event stream, add a parser; and
> pin the exact session via `--resume-id` (parse it from `--list-sessions`).

> **Codex (added, text-mode v1):** non-interactive via `codex exec "<prompt>"`,
> run autonomously-but-sandboxed with `--ask-for-approval never --sandbox
> workspace-write` (the nuclear option is `--dangerously-bypass-approvals-and-
> sandbox`). Output text is ANSI-stripped. **Not wired yet:** multi-turn resume
> (each turn is a fresh `exec`) and rich tool previews (Codex has `--json` JSONL
> — parser TODO). Auth: `~/.codex/auth.json` or `OPENAI_API_KEY`; `codex login`.

## History storage (how we replay past conversations)

The `history` field in each `agents.ts` contract records *where* an agent keeps
its transcripts and *whether we read them yet*. The ecosystem pattern:

- **Content is often per-session JSONL.** Claude (`~/.claude/projects`), the
  Cursor CLI (`~/.cursor/projects/**/agent-transcripts`), and Codex
  (`~/.codex/sessions/**/rollout-*.jsonl`) we read directly. For Codex the
  `state_*.sqlite` `threads.rollout_path` is just an index pointing at the JSONL.
- **Some CLIs keep the transcript *in* a SQLite DB** (not JSONL):
  - **GitHub Copilot** — `~/.copilot/session-store.db`: `sessions` + `turns`
    (user_message/assistant_response) + `forge_trajectory_events` (tool calls).
    Read via `bun:sqlite` (`copilot-sessions.ts`).
  - **Kiro** (= Amazon Q CLI rebranded) — `~/Library/Application Support/kiro-cli/
    data.sqlite3`: `conversations(key=cwd, value=serde_json(ConversationState))`.
    Read via `bun:sqlite` (`kiro-sessions.ts`); tolerates the table being absent
    until a chat persists one.
- **Desktop apps** bury content in their own DBs (Cursor desktop `state.vscdb`,
  Codex desktop `orbit.db`) — a separate, opt-in lift, intentionally not covered.

All five supported CLIs now have history readers; the per-agent store + reader
status lives in `agents.ts` (`history` field).

**Bounded reads (hard limits):** `file-read.ts` ensures we never slurp a whole
transcript. `readTail` reads at most `TAIL_BYTES` (1 MB) from the end for history
(we only render the last ~20 messages anyway); `readHead` reads at most
`HEAD_BYTES` (64 KB) from the start for first-message/cwd peeks. Cost is O(cap),
independent of file size. (Previously history did `readFileSync(wholeFile)` and
the peeks used a fixed 4 KB read that could miss a first message pushed past 4 KB.)

## Learnings from Codex's own remote control (for the eventual relay/adapter work)

Codex ships almost exactly Diktat's "phone drives a Mac agent via a cloud relay"
architecture, mostly open-source under `codex-rs/`. Worth borrowing later:

1. **Target `codex app-server` (stdio JSON-RPC) instead of `codex exec` scraping.**
   It exposes a typed Thread→Turn→Item protocol: `thread/start|resume|list|read`,
   `turn/start|interrupt|steer`, and `item/*` streaming notifications
   (`item/agentMessage/delta`, `item/commandExecution/outputDelta`,
   `item/fileChange/patchUpdated`, `item/reasoning/textDelta`, …). These map
   straight onto Diktat's normalized `output`/`tool_use`/`tool_result`/`exit`,
   and give real `thread/resume` — no JSONL reverse-engineering. (This is the
   first-class path for the adapter-registry refactor, #22.)
2. **Copy the pairing-code model.** `remoteControl/pairing/start` → short-lived
   `{ pairingCode, manualPairingCode?, expiresAt }`; phone redeems against the
   relay; Mac polls `remoteControl/pairing/status → { claimed }`. The backend
   `serverId` is **never exposed to clients**. (We already do device-auth pairing;
   this validates the shape.)
3. **Relay/account is the source of truth for paired devices; keep local state
   minimal.** Codex stores only an enrollment tuple `(websocket_url, account_id,
   client_name) → (server_id, environment_id, server_name)` on the Mac, and does
   device list/revoke as account-level relay ops. Notably they **added local
   per-device key bindings (migration 0028) then dropped them (0031)** — a signal
   not to build a local device-key store on the daemon.
4. **Split lifecycle supervision from the agent connection.** Their
   `app-server-daemon` is a thin pidfile/lockfile supervisor (start/stop/enable
   remote control/auto-update) that prints exactly one JSON object per command;
   the long-lived agent process owns the outbound relay socket. Diktat's daemon
   already keeps a clean machine-readable CLI surface — keep that discipline.
5. **Per-connection notification opt-out + backpressure.** `initialize` accepts
   `optOutNotificationMethods` so a bandwidth-constrained phone can suppress
   high-volume deltas; overload is rejected with JSON-RPC `-32001` expecting
   client backoff. Cheap to mirror in our relay protocol.

> Caveat: the relay/broker itself is **not** open-source — the pairing-code claim
> logic, phone auth, and relay framing are server-side. The repo only shows the
> Mac-side client dialing `wss://.../backend-api/wham/remote/control/server`.

## The landscape (major agentic CLIs)

| Agent | Binary | One-shot invocation | Output format | Resume | Notes |
|---|---|---|---|---|---|
| Claude Code | `claude` | `-p "<prompt>"` | structured `stream-json` | `--resume <id>` | **supported** |
| Cursor | `agent`/`cursor` | `-p "<prompt>"` | structured `stream-json` | `--resume=<id>` | **supported**, `--mode`, `--trust` |
| GitHub Copilot | `copilot` | `-p "<prompt>"` | text (`--silent`); JSONL via `--output-format json` | `--session-id <uuid>` (we own it) | **supported** (text v1; JSON parser TODO), `--allow-all-tools` |
| Kiro | `kiro-cli` | `chat --no-interactive "<prompt>"` | plain text (no chat JSON stream) | `--resume` (most recent in dir) / `--resume-id` | **supported** (text v1), `--trust-all-tools`, ANSI-stripped |
| OpenAI Codex CLI | `codex` | `codex exec "<prompt>"` | plain text (`--json` JSONL TODO) | not wired (v1 stateless) | **supported** (text v1), `--ask-for-approval never --sandbox workspace-write`, ANSI-stripped |
| Gemini CLI | `gemini` | `-p "<prompt>"` | streaming text; JSON option | partial | open source (Google) |
| Aider | `aider` | `-m "<msg>" --yes` | **plain text + diffs** (no structured JSON) | chat history | huge install base |
| opencode | `opencode` | headless / server mode | JSON over local API | yes | open source (SST) |
| Amp | `amp` | execute mode (`-x`) | JSON streaming | yes | Sourcegraph |
| Goose | `goose` | `goose run …` | text / recipe events | sessions | open source (Block) |

> Exact flags drift; each adapter must be verified against the CLI's current
> docs/version when written. The table is for shape, not as a spec.

## How they differ (the 4 axes)

1. **Invocation** — prompt flag (`-p` vs `-m` vs positional `exec`), trust/yolo
   flags, model/mode selection.
2. **Output** — structured event JSON (Claude/Cursor/Codex/Amp) vs plain text +
   diffs (Aider) vs a local HTTP/socket API (opencode). Event schemas are
   per-vendor and sometimes undocumented (cf. Cursor's tool_call shapes).
3. **Sessions / resume** — server-side session id (Claude/Cursor) vs local chat
   files vs none.
4. **Auth / "logged in" check** — OAuth login (Claude), API-key env var
   (most others), or IDE-managed (Cursor).

## The approach: adapter pattern + normalized events

Diktat's relay/app protocol already speaks **normalized events**
(`output`, `tool_use`, `tool_result`, `exit` — see `PROTOCOL.md`). The app is
already agent-agnostic. Only the daemon knows about specific CLIs, and only in
two places today:

- `cli-detector.ts` — the `KNOWN_CLIS` map (detection).
- `session.ts` — `buildArgs()` (invocation) + `parseClaudeChunk`/`parseCursorChunk`
  (native → normalized translation).

**Plan: extract these into a per-agent `AgentAdapter` and a registry.**

```ts
interface AgentAdapter {
  id: string;                         // "claude" | "cursor" | "codex" | ...
  displayName: string;                // "Claude Code"
  detect(spawn): Promise<string|null>;// resolve binary path, or null if absent
  capabilities: {                     // lets the app/UI adapt
    resume: boolean;
    structuredEvents: boolean;        // false → text-only, no rich tool previews
    modes?: string[];
  };
  buildArgs(opts: { cliPath; prompt; sessionId?; mode? }): string[];
  // Translate a raw stdout/stderr chunk into normalized events. Owns all
  // vendor-specific schema knowledge. Returns events + control signals
  // (e.g. "session expired, retry without resume").
  parseChunk(chunk: string, ctx: ParseCtx): { events: NormalEvent[]; retry?: boolean; sessionId?: string };
}
```

- A **registry** (`adapters/index.ts`) lists adapters; `detectCLIs()` iterates it.
- `Session` becomes adapter-driven: it holds an `AgentAdapter` and calls
  `buildArgs` / `parseChunk` instead of switching on `cli`.
- Existing Claude/Cursor logic moves verbatim into `adapters/claude.ts` /
  `adapters/cursor.ts` (behaviour-preserving refactor; tests guard it).

### Two tiers of support
- **First-class adapters** (hand-written): rich tool previews, resume, run
  summaries. For top products — add Codex, Gemini next.
- **Generic adapter** (config-driven): for *any* CLI that takes a one-shot prompt
  flag and streams text. Configured in `config.json`:
  ```json
  { "agents": { "mytool": { "command": "mytool", "promptFlag": "-m", "resumeFlag": null } } }
  ```
  Falls back to the existing passthrough (`{type:"output"}`) — no rich previews,
  but it *works*. This is the "anything can be integrated" answer: hand-write
  adapters for the big names, let the generic adapter cover the long tail.

## Suggested rollout order (post-release)
1. **Refactor** Claude/Cursor into adapters + registry (no behaviour change).
2. **Generic config-driven adapter** (unlocks the long tail immediately).
3. **Codex CLI** + **Gemini CLI** (biggest names, structured-ish output).
4. **Aider** (huge base, but plain-text → generic/degraded experience first).
5. **opencode / Amp / Goose** as demand appears.

## Where the supported list lives (single source of truth)
The adapter registry IS the list. Surface it:
- `diktat setup` already prints detected CLIs — drive that from the registry.
- Expose `displayName` + `capabilities` so the app can show "Supported agents"
  and adapt UI (e.g. hide tool-preview affordances for text-only agents).
- Mirror the registry into a short section in `README.md` / the landing page.
