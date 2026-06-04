import { existsSync, readFileSync } from "fs";

interface Config {
  port: number;
  projects: string[];
  /** Transport mode. Default "local" (Tailscale + Bun.serve), unchanged behavior. */
  mode?: "local" | "relay";
  /** Relay base URL (e.g. wss://relay.example.com). Required in relay mode. */
  relayUrl?: string;
  /** This machine's id, registered with the relay. Required in relay mode. */
  machineId?: string;
  /** Per-machine daemon bearer token for the agent leg. Required in relay mode. */
  daemonToken?: string;
}

const CONFIG_PATH = "./config.json";

export function loadConfig(configPath = CONFIG_PATH): Config {
  if (!existsSync(configPath)) {
    console.error(`No config.json found. Copy config.example.json to config.json and edit it.`);
    process.exit(1);
  }
  const cfg = JSON.parse(readFileSync(configPath, "utf-8")) as Config;
  // Default mode is "local" so existing configs behave exactly as before.
  if (cfg.mode === undefined) cfg.mode = "local";
  return cfg;
}

export type { Config };
