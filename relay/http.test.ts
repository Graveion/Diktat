import { describe, expect, it } from "bun:test";
import { clientIp, RateLimiter } from "./http.ts";

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://relay.test/x", { headers });
}

describe("clientIp", () => {
  it("prefers Fly-Client-IP over x-forwarded-for", () => {
    expect(clientIp(req({ "fly-client-ip": "1.2.3.4", "x-forwarded-for": "5.6.7.8" }))).toBe("1.2.3.4");
  });

  it("falls back to the LAST x-forwarded-for entry", () => {
    expect(clientIp(req({ "x-forwarded-for": "9.9.9.9, 5.6.7.8" }))).toBe("5.6.7.8");
  });

  it("returns unknown with no headers", () => {
    expect(clientIp(req())).toBe("unknown");
  });
});

describe("RateLimiter", () => {
  it("allows up to max then rejects within the window", () => {
    const rl = new RateLimiter(3, 60_000);
    const now = 1_000_000;
    expect(rl.check("a", now)).toBe(true);
    expect(rl.check("a", now)).toBe(true);
    expect(rl.check("a", now)).toBe(true);
    expect(rl.check("a", now)).toBe(false);
  });

  it("isolates per-endpoint buckets (different keys)", () => {
    const rl = new RateLimiter(1, 60_000);
    const now = 1_000_000;
    expect(rl.check("/pair/init:1.2.3.4", now)).toBe(true);
    expect(rl.check("/pair/init:1.2.3.4", now)).toBe(false);
    expect(rl.check("/pair/complete:1.2.3.4", now)).toBe(true); // unaffected
  });

  it("resets after the window elapses", () => {
    const rl = new RateLimiter(1, 60_000);
    expect(rl.check("a", 0)).toBe(true);
    expect(rl.check("a", 1)).toBe(false);
    expect(rl.check("a", 60_000)).toBe(true);
  });

  it("sweep evicts expired entries only", () => {
    const rl = new RateLimiter(20, 60_000);
    rl.check("old", 0);
    rl.check("fresh", 50_000);
    expect(rl.size).toBe(2);
    rl.sweep(60_000);
    expect(rl.size).toBe(1);
    rl.sweep(200_000);
    expect(rl.size).toBe(0);
  });
});
