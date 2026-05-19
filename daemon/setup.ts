import { createInterface } from "readline";
import { existsSync, writeFileSync, readFileSync } from "fs";
import { detectCLIs } from "./cli-detector";
import { getTailscaleIP } from "./tailscale";

const rl = createInterface({ input: process.stdin, output: process.stdout });

const ask = (q: string): Promise<string> =>
  new Promise((resolve) => rl.question(q, resolve));

const print = (msg: string) => console.log(msg);
const ok = (msg: string) => print(`  ✓ ${msg}`);
const fail = (msg: string) => print(`  ✗ ${msg}`);
const section = (msg: string) => print(`\n${msg}`);

async function checkCLILogin(cli: string): Promise<boolean> {
  const proc = Bun.spawn(["claude", "-p", "hi", "--output-format", "stream-json", "--verbose"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return !text.includes("authentication_failed") && !text.includes("Not logged in");
}

async function runCLILogin(cli: string): Promise<void> {
  print(`  Running: ${cli} login`);
  const proc = Bun.spawn([cli, "login"], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  await proc.exited;
}

async function waitForTailscale(): Promise<string | null> {
  const proc = Bun.spawn(["tailscale", "up"], { stdout: "pipe", stderr: "pipe" });
  proc.exited.then(() => {});
  let attempts = 0;
  while (attempts < 30) {
    const ip = getTailscaleIP();
    if (ip) return ip;
    await Bun.sleep(2000);
    process.stdout.write(".");
    attempts++;
  }
  print("");
  return null;
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

  for (const name of detectedNames) ok(`${name} (${detected[name]})`);

  // --- Login check ---
  section("Checking CLI authentication...");
  for (const cli of detectedNames) {
    if (cli === "claude") {
      const loggedIn = await checkCLILogin(cli);
      if (loggedIn) {
        ok(`${cli} is logged in`);
      } else {
        fail(`${cli} is not logged in`);
        const doLogin = await ask(`  Log in to ${cli} now? (y/n): `);
        if (doLogin.trim().toLowerCase() === "y") {
          await runCLILogin(cli);
        } else {
          print(`  Skipping — run '${cli} login' before starting the daemon.`);
        }
      }
    }
  }

  // --- Tailscale ---
  section("Checking Tailscale...");
  let tsIP = getTailscaleIP();
  if (tsIP) {
    ok(`Connected: ${tsIP}`);
  } else {
    fail("Not connected");
    const doConnect = await ask("  Connect now? (y/n): ");
    if (doConnect.trim().toLowerCase() === "y") {
      process.stdout.write("  Connecting");
      tsIP = await waitForTailscale();
      if (tsIP) {
        ok(`Connected: ${tsIP}`);
      } else {
        fail("Could not connect. Run 'tailscale up' manually before starting the daemon.");
      }
    }
  }

  // --- Projects ---
  section("Project directories:");
  print("  Enter full paths to your project directories, one per line.");
  print("  Leave blank and press enter when done.\n");

  const projects: string[] = [];
  while (true) {
    const input = (await ask("  > ")).trim();
    if (!input) break;
    if (!existsSync(input)) {
      print(`  ! Path not found: ${input}`);
    } else {
      projects.push(input);
      ok(input);
    }
  }

  if (projects.length === 0) {
    print("\n  ! No projects added. Edit daemon/config.json manually to add them.");
  }

  // --- Write config ---
  const CONFIG_PATH = "./config.json";
  const existing = existsSync(CONFIG_PATH)
    ? JSON.parse(readFileSync(CONFIG_PATH, "utf-8"))
    : {};

  const config = {
    port: existing.port ?? 9000,
    projects: projects.length > 0 ? projects : (existing.projects ?? []),
  };

  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  section(`Config written to daemon/config.json`);

  // --- Done ---
  print("\n╔════════════════════════════╗");
  print("║      Setup complete!       ║");
  print("╚════════════════════════════╝");
  print("\nRun: ./daemon.sh start");
  print("     ./daemon.sh logs\n");

  rl.close();
}

main();
