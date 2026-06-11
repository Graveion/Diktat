/**
 * RevenueCat webhook → account_state.entitled_until.
 *
 * RC can only POST to an HTTP endpoint, not write Postgres directly, so this
 * Edge Function is the receiver: it verifies RC's shared secret, extracts the
 * subscription expiry, and upserts it into `account_state`. The relay reads
 * that column at connect time for its server-side entitlement gate.
 *
 * Auth: RC sends a fixed `Authorization` header value (configured in the RC
 * dashboard) that must equal the RC_WEBHOOK_SECRET function secret. Because RC
 * doesn't send a Supabase JWT, this function MUST have `verify_jwt = false`
 * (see supabase/config.toml [functions.rc-webhook]).
 *
 * Secrets (set via `supabase secrets set`): RC_WEBHOOK_SECRET.
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.
 */

const RC_WEBHOOK_SECRET = Deno.env.get("RC_WEBHOOK_SECRET");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

/** Clamp ceiling for expiration_at_ms — anything further out is treated as bogus. */
const TWO_YEARS_MS = 2 * 365 * 24 * 3_600_000;

/** Constant-time string compare (no early return on equal-length inputs). */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export async function handle(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  // Fail closed: never process an event we can't authenticate or persist.
  if (!RC_WEBHOOK_SECRET) return json({ error: "webhook not configured" }, 503);
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ error: "unavailable" }, 503);

  const auth = req.headers.get("authorization") ?? "";
  if (!constantTimeEqual(auth, RC_WEBHOOK_SECRET)) return new Response("unauthorized", { status: 401 });

  let body: { event?: { type?: string; app_user_id?: string; expiration_at_ms?: number | null } };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }

  const event = body.event;
  const accountId = event?.app_user_id;
  if (!accountId) return json({ ok: true }); // anonymous / no user id — ignore

  // We write expiration_at_ms as entitled_until: active subscription → future
  // date; expired/cancelled/refunded → past date; the relay gate compares
  // against now() so both resolve correctly. An event WITHOUT an expiration
  // tells us nothing about access, so we skip rather than null-wiping a live
  // entitlement — keeping any enabled event type safe.
  let expiresMs = event?.expiration_at_ms ?? null;
  if (expiresMs == null) {
    console.log(`[rc-webhook] ${event?.type} accountId=${accountId} — no expiration, ignored`);
    return json({ ok: true });
  }
  if (typeof expiresMs !== "number" || !Number.isFinite(expiresMs))
    return json({ error: "invalid expiration_at_ms" }, 400);
  const max = Date.now() + TWO_YEARS_MS;
  if (expiresMs > max) expiresMs = max;
  const entitledUntil = new Date(expiresMs).toISOString();

  // Upsert — the row may not exist yet if the user subscribed before starting a
  // trial session (family sharing / promo). merge-duplicates updates in place.
  const res = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/rest/v1/account_state`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates",
    },
    body: JSON.stringify({ account_id: accountId, entitled_until: entitledUntil }),
  });
  if (!res.ok) {
    console.error(`[rc-webhook] upsert failed (${res.status}) for ${accountId}`);
    return json({ error: "persist failed" }, 502);
  }

  console.log(`[rc-webhook] ${event?.type} accountId=${accountId} entitled_until=${entitledUntil}`);
  return json({ ok: true });
}

Deno.serve(handle);
