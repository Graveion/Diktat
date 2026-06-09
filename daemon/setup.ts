import { createInterface } from "readline";
import { existsSync, writeFileSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { detectCLIs } from "./cli-detector";
import { cursorShellPermissionGranted, grantCursorShellPermission } from "./cursor-shell-permissions";

const rl = createInterface({ input: process.stdin, output: process.stdout });

const ask = (q: string): Promise<string> =>
  new Promise((resolve) => rl.question(q, resolve));

const print = (msg: string) => console.log(msg);
const ok = (msg: string) => print(`  ✓ ${msg}`);
const fail = (msg: string) => print(`  ✗ ${msg}`);
const info = (msg: string) => print(`  · ${msg}`);
const section = (msg: string) => print(`\n${msg}`);

async function checkClaudeLogin(): Promise<boolean> {
  try {
    const proc = Bun.spawn(
      ["claude", "-p", "hi", "--output-format", "stream-json", "--verbose"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const text = await new Response(proc.stderr).text();
    await proc.exited;
    return !text.includes("authentication_failed") && !text.includes("Not logged in");
  } catch {
    return false;
  }
}

async function checkCopilotLogin(): Promise<boolean> {
  try {
    const proc = Bun.spawn(
      ["copilot", "-p", "hi", "--silent", "--allow-all-tools", "--no-color"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const text = await new Response(proc.stderr).text();
    await proc.exited;
    return !/No authentication information found/i.test(text);
  } catch {
    return false;
  }
}

async function runLogin(cli: string): Promise<void> {
  print(`  Running: ${cli} login`);
  const proc = Bun.spawn([cli, "login"], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  await proc.exited;
}

function findGitRepos(baseDir: string, maxDepth = 2): string[] {
  const repos: string[] = [];
  if (!existsSync(baseDir)) return repos;
  try {
    const scan = (dir: string, depth: number) => {
      if (depth > maxDepth) return;
      if (existsSync(join(dir, ".git"))) {
        repos.push(dir);
        return; // don't recurse into nested repos
      }
      try {
        for (const entry of readdirSync(dir)) {
          if (entry.startsWith(".")) continue;
          const full = join(dir, entry);
          try {
            if (statSync(full).isDirectory()) scan(full, depth + 1);
          } catch { /* skip permission errors */ }
        }
      } catch { /* skip unreadable dirs */ }
    };
    scan(baseDir, 0);
  } catch { /* skip */ }
  return repos;
}

async function selectProjects(): Promise<string[]> {
  const home = homedir();
  const searchDirs = [
    join(home, "Documents"),
    join(home, "Documents", "Development"),
    join(home, "projects"),
    join(home, "code"),
    join(home, "src"),
    join(home, "personal"),
    join(home, "work"),
  ];

  print("  Scanning for git repositories...");
  const found: string[] = [];
  for (const dir of searchDirs) {
    for (const repo of findGitRepos(dir)) {
      if (!found.includes(repo)) found.push(repo);
    }
  }

  if (found.length === 0) {
    info("No git repos found. Enter paths manually (blank line to finish):");
    const manual: string[] = [];
    while (true) {
      const input = (await ask("  > ")).trim();
      if (!input) break;
      if (!existsSync(input)) {
        print(`  ! Path not found: ${input}`);
      } else {
        manual.push(input);
        ok(input);
      }
    }
    return manual;
  }

  print(`\n  Found ${found.length} repositories. Select which to allow (y/n):\n`);
  const selected: string[] = [];
  for (const repo of found) {
    const label = repo.replace(home, "~");
    const answer = (await ask(`  ${label}? (y/n): `)).trim().toLowerCase();
    if (answer === "y") {
      selected.push(repo);
      ok(label);
    }
  }

  if (selected.length === 0) {
    info("None selected. Enter paths manually (blank line to finish):");
    while (true) {
      const input = (await ask("  > ")).trim();
      if (!input) break;
      if (!existsSync(input)) {
        print(`  ! Path not found: ${input}`);
      } else {
        selected.push(input);
        ok(input);
      }
    }
  }

  return selected;
}

async function main() {
  print("╔════════════════════════════╗");
  print("║      Diktat Setup          ║");
  print("╚════════════════════════════╝");

  // --- CLIs ---
  section("Detecting CLIs...");
  const detected = await detectCLIs();
  const detectedNames = Object.keys(detected);

  if (detectedNames.length === 0) {
    fail("No supported CLIs found. Install claude or cursor and re-run setup.");
    process.exit(1);
  }

  for (const name of detectedNames) ok(`${name}`);

  // --- Login check ---
  section("Checking CLI authentication...");
  for (const cli of detectedNames) {
    if (cli === "claude") {
      const loggedIn = await checkClaudeLogin();
      if (loggedIn) {
        ok("Claude is logged in");
      } else {
        fail("Claude is not logged in");
        const doLogin = (await ask("  Log in to Claude now? (y/n): ")).trim().toLowerCase();
        if (doLogin === "y") {
          await runLogin("claude");
        } else {
          info("Skipping — run 'claude login' before starting the daemon.");
        }
      }
    } else if (cli === "cursor") {
      // Cursor auth is managed by the IDE — no CLI login needed
      ok("Cursor auth is managed by the IDE");
      // Check / offer to grant Shell(*) so the cursor CLI can run shell commands
      if (cursorShellPermissionGranted()) {
        ok("Shell(*) already granted in ~/.cursor/cli-config.json");
      } else {
        info("Shell(*) is not set in ~/.cursor/cli-config.json.");
        info("Without it the Cursor CLI cannot run shell commands.");
        const grant = (await ask("  Add Shell(*) to ~/.cursor/cli-config.json? (y/n): ")).trim().toLowerCase();
        if (grant === "y") {
          grantCursorShellPermission();
          ok("Shell(*) added to ~/.cursor/cli-config.json");
        } else {
          info("Skipped — cursor sessions may have limited shell access.");
        }
      }
    } else if (cli === "copilot") {
      const loggedIn = await checkCopilotLogin();
      if (loggedIn) {
        ok("GitHub Copilot is authenticated");
      } else {
        fail("GitHub Copilot is not authenticated");
        const doLogin = (await ask("  Log in to Copilot now? (y/n): ")).trim().toLowerCase();
        if (doLogin === "y") {
          await runLogin("copilot");
        } else {
          info("Skipping — run `copilot` then `/login` (or set GITHUB_TOKEN) before starting the daemon.");
        }
      }
    }
  }

  // --- Projects ---
  section("Project directories:");
  const projects = await selectProjects();

  if (projects.length === 0) {
    info("No projects added. Edit daemon/config.json manually to add them.");
  }

  // --- Write config ---
  const CONFIG_PATH = "./config.json";
  const existing = existsSync(CONFIG_PATH)
    ? JSON.parse(readFileSync(CONFIG_PATH, "utf-8"))
    : {};

  // Preserve relay credentials (relayUrl/machineId/daemonToken) written by `diktat pair`.
  const config = {
    ...existing,
    port: existing.port ?? 9000,
    projects: projects.length > 0 ? projects : (existing.projects ?? []),
  };

  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  section("Config written to daemon/config.json");

  // --- Done ---
  print("\n╔════════════════════════════╗");
  print("║      Setup complete!       ║");
  print("╚════════════════════════════╝");
  const paired = Boolean(existing.machineId && existing.daemonToken);
  if (paired) {
    print("\n  Run: diktat start\n");
  } else {
    print("\n  Next: open the Diktat app, tap “Pair a machine”, then run:");
    print("        diktat pair <code>\n");
  }

  rl.close();
}

main();
