import { existsSync, readFileSync } from "fs";

interface Config {
  port: number;
  projects: string[];
}

const CONFIG_PATH = "./config.json";

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    console.error(`No config.json found. Copy config.example.json to config.json and edit it.`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}
