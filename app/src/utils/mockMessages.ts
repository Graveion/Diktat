import type { DiktatMessage } from "../hooks/useDiktat";

// Fabricated demo conversation used for offline UI rendering, Maestro flows, and
// App Store screenshots. NOT from any real session — safe to display publicly.
export const MOCK_MESSAGES: DiktatMessage[] = [
  {
    role: "user",
    text: "Add rate limiting to the checkout endpoint",
  },
  {
    role: "assistant",
    text: "I'll add a token-bucket limiter to the checkout route, wire it into the middleware stack, and cover it with tests.",
  },
  {
    role: "assistant",
    text: "Here's the plan before I touch anything:\n\n## Approach\n\n| Step | What | Where |\n|------|------|-------|\n| 1 | Token-bucket limiter (60 req/min per IP) | `src/middleware/rateLimiter.ts` |\n| 2 | Apply it to the checkout route only | `src/routes/checkout.ts` |\n| 3 | Return `429` with a `Retry-After` header | limiter |\n| 4 | Unit-test refill, burst, and reject paths | `rateLimiter.test.ts` |\n\nKeeping it dependency-free — an in-memory bucket keyed by client IP.",
  },
  {
    role: "tool",
    text: "",
    toolName: "Edit:rateLimiter.ts",
    toolPath: "/Users/you/code/storefront/src/middleware/rateLimiter.ts",
    toolDiff:
      "+ export function rateLimiter(opts: { perMinute: number }) {\n+   const buckets = new Map<string, Bucket>();\n+   return (req, res, next) => {\n+     const b = take(buckets, req.ip, opts.perMinute);\n+     if (b.allowed) return next();\n+     res.setHeader(\"Retry-After\", b.retryAfter);\n+     res.status(429).json({ error: \"rate_limited\" });\n+   };\n+ }",
    toolResult: "The file has been edited successfully.",
    toolTruncated: false,
    toolResultTruncated: false,
    toolFullSize: 980,
  },
  {
    role: "assistant",
    text: "Done. The checkout endpoint is now rate limited.\n\n### What changed\n\n| File | Change |\n|------|--------|\n| `middleware/rateLimiter.ts` | New token-bucket limiter, `429` + `Retry-After` |\n| `routes/checkout.ts` | `rateLimiter({ perMinute: 60 })` added to the chain |\n| `rateLimiter.test.ts` | Covers refill, burst allowance, and rejection |\n\n```ts\nrouter.post(\n  \"/checkout\",\n  rateLimiter({ perMinute: 60 }),\n  validateCart,\n  createOrder,\n);\n```\n\nNo new dependencies — the bucket is in-memory and keyed by client IP.",
  },
  {
    role: "user",
    text: "run the tests",
  },
  {
    role: "assistant",
    text: "Running the checkout suite.",
  },
  {
    role: "assistant",
    text: "**24/24 passed** ✅  (1.8s)\n\n```bash\n$ npm test -- checkout\n\n  checkout\n    ✓ accepts an order under the limit\n    ✓ rejects the 61st request in a window with 429\n    ✓ sends a Retry-After header\n    ✓ refills the bucket after the window\n\n  Test Suites: 1 passed\n  Tests:       24 passed, 24 total\n```\n\nWant me to make the limit configurable per environment, or move the bucket to Redis so it works across instances?",
  },
];
