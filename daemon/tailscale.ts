import { networkInterfaces } from "os";

export function getTailscaleIP(): string | null {
  const nets = networkInterfaces();
  for (const interfaces of Object.values(nets)) {
    for (const iface of interfaces ?? []) {
      if (iface.family === "IPv4" && iface.address.startsWith("100.")) {
        return iface.address;
      }
    }
  }
  return null;
}
