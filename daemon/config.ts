import { existsSync, readFileSync } from "fs";

interface Config {
  port: number;
  projects: string[];
}

const CONFIG_PATH = "./config.json";

export function loadConfig(configPath = CONFIG_PATH): Config {
  if (!existsSync(configPath)) {
    console.error(`No config.json found. Copy config.example.json to config.json and edit it.`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(configPath, "utf-8"));
}
