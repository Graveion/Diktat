import { loadConfig } from "./config";
import { getTailscaleIP } from "./tailscale";
import qrcode from "qrcode-terminal";

const config = loadConfig();
const tailscaleIP = getTailscaleIP();

if (!tailscaleIP) {
  console.error("No Tailscale interface found. Is Tailscale running?");
  process.exit(1);
}

const connectionUrl = `diktat://${tailscaleIP}:${config.port}`;
console.log("\nScan to connect with Diktat app:\n");
qrcode.generate(connectionUrl, { small: true });
console.log(`  ${connectionUrl}\n`);
