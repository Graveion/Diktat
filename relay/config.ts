import { readFileSync } from "node:fs";

/**
 * Static registry modelling the future DB (RELAY.md §2).
 *
 *   machines[machineId]      -> { daemonToken, accountId }
 *   accountTokens[token]     -> accountId
 */
export interface MachineEntry {
  daemonToken: string;
  accountId: string;
}

export interface RelayConfig {
  machines: Record<string, MachineEntry>;
  accountTokens: Record<string, string>;
}

const DEFAULT_CONFIG_PATH = "./relay-config.json";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validate + normalize an unknown value into a RelayConfig (throws on bad shape). */
export function parseConfig(raw: unknown): RelayConfig {
  if (!isRecord(raw)) throw new Error("relay config must be a JSON object");

  const machinesRaw = raw.machines;
  if (!isRecord(machinesRaw)) throw new Error("relay config: `machines` must be an object");
  const machines: Record<string, MachineEntry> = {};
  for (const [machineId, entry] of Object.entries(machinesRaw)) {
    if (!isRecord(entry)) throw new Error(`relay config: machines["${machineId}"] must be an object`);
    const { daemonToken, accountId } = entry;
    if (typeof daemonToken !== "string" || daemonToken.length === 0)
      throw new Error(`relay config: machines["${machineId}"].daemonToken must be a non-empty string`);
    if (typeof accountId !== "string" || accountId.length === 0)
      throw new Error(`relay config: machines["${machineId}"].accountId must be a non-empty string`);
    machines[machineId] = { daemonToken, accountId };
  }

  const accountTokensRaw = raw.accountTokens;
  if (!isRecord(accountTokensRaw)) throw new Error("relay config: `accountTokens` must be an object");
  const accountTokens: Record<string, string> = {};
  for (const [token, accountId] of Object.entries(accountTokensRaw)) {
    if (typeof accountId !== "string" || accountId.length === 0)
      throw new Error(`relay config: accountTokens["${token}"] must be a non-empty accountId string`);
    accountTokens[token] = accountId;
  }

  return { machines, accountTokens };
}

/**
 * Load config. Injectable for tests:
 *  - pass a RelayConfig object  -> validated & returned as-is
 *  - pass a path string         -> read + parse that file
 *  - pass nothing               -> env DIKTAT_RELAY_CONFIG or ./relay-config.json
 */
export function loadConfig(source?: RelayConfig | string): RelayConfig {
  if (source && typeof source === "object") return parseConfig(source);
  const path = source ?? process.env.DIKTAT_RELAY_CONFIG ?? DEFAULT_CONFIG_PATH;
  const text = readFileSync(path, "utf8");
  return parseConfig(JSON.parse(text));
}
