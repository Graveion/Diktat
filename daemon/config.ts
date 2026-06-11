import { chmodSync, existsSync, readFileSync, statSync } from "fs";

interface Config {
  port: number;
  projects: string[];
  /** Relay base URL (e.g. wss://diktat-relay.fly.dev). Written by `diktat pair`. */
  relayUrl?: string;
  /** This machine's id, registered with the relay. Written by `diktat pair`. */
  machineId?: string;
  /** Per-machine daemon bearer token for the agent leg. Written by `diktat pair`. */
  daemonToken?: string;
}

const CONFIG_PATH = "./config.json";

export function loadConfig(configPath = CONFIG_PATH): Config {
  if (!existsSync(configPath)) {
    console.error(`No config.json found. Run \`diktat setup\`, then \`diktat pair <code>\`.`);
    process.exit(1);
  }
  // config.json holds the relay bearer token — keep it owner-only (best-effort).
  try {
    if ((statSync(configPath).mode & 0o077) !== 0) chmodSync(configPath, 0o600);
  } catch { /* best-effort */ }
  return JSON.parse(readFileSync(configPath, "utf-8")) as Config;
}

export type { Config };
