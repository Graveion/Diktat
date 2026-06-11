/**
 * HTTP-edge helpers for index.ts, extracted so they're unit-testable without
 * standing up Bun.serve.
 */

/** Client IP: trust Fly-Client-IP (set by Fly's proxy), else the LAST x-forwarded-for hop (earlier entries are client-spoofable). */
export function clientIp(req: Request): string {
  const fly = req.headers.get("fly-client-ip");
  if (fly) return fly;
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length > 0) return parts[parts.length - 1];
  }
  return "unknown";
}

/** Fixed-window per-key rate limiter (default 20 requests / 60s per key). */
export class RateLimiter {
  private readonly counts = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max = 20,
    private readonly windowMs = 60_000,
  ) {}

  /** Count a hit for `key`; true if still within the limit. */
  check(key: string, now = Date.now()): boolean {
    let entry = this.counts.get(key);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.counts.set(key, entry);
    }
    entry.count++;
    return entry.count <= this.max;
  }

  /** Evict expired windows so spoofed keys can't grow the map unboundedly. */
  sweep(now = Date.now()): void {
    for (const [key, entry] of this.counts) {
      if (now >= entry.resetAt) this.counts.delete(key);
    }
  }

  get size(): number {
    return this.counts.size;
  }
}
