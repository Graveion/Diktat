import { existsSync, readFileSync } from "fs";

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
  return JSON.parse(readFileSync(configPath, "utf-8")) as Config;
}

export type { Config };
