/**
 * Scheduled sweep of the `agent-uploads` Storage bucket.
 *
 * Images the phone attaches to a chat turn are single-use: the daemon downloads
 * the signed URL, hands the local file to the CLI, and deletes its *local* temp
 * copy — but the *object* in Storage would otherwise linger forever (cost +
 * privacy). This function deletes every object older than MAX_AGE_MS. Deleting
 * via the Storage API (not a raw DELETE on storage.objects) reclaims the backing
 * S3 bytes; a raw row delete would orphan them.
 *
 * Invoked daily by pg_cron → pg_net (see migration 0007). Not a public endpoint:
 * `verify_jwt = false` (cron sends no Supabase JWT), so it's gated by a fixed
 * `x-cleanup-secret` header that must equal the CLEANUP_SECRET function secret.
 *
 * Secrets (via `supabase secrets set`): CLEANUP_SECRET.
 * SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.
 */

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const CLEANUP_SECRET = Deno.env.get("CLEANUP_SECRET");

const BUCKET = "agent-uploads";
const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const LIST_PAGE = 1000;
const DELETE_BATCH = 100;

/** Constant-time compare so the secret check doesn't leak length via timing. */
function secretsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface StorageEntry {
  name: string;
  id: string | null; // null => it's a folder (prefix), not an object
  created_at?: string | null;
}

function storageHeaders(): HeadersInit {
  return {
    "Authorization": `Bearer ${SERVICE_ROLE_KEY}`,
    "apikey": SERVICE_ROLE_KEY as string,
    "Content-Type": "application/json",
  };
}

const base = () => (SUPABASE_URL as string).replace(/\/$/, "");

/** One page of a prefix listing. */
async function listPage(prefix: string, offset: number): Promise<StorageEntry[]> {
  const res = await fetch(`${base()}/storage/v1/object/list/${BUCKET}`, {
    method: "POST",
    headers: storageHeaders(),
    body: JSON.stringify({ prefix, limit: LIST_PAGE, offset, sortBy: { column: "name", order: "asc" } }),
  });
  if (!res.ok) throw new Error(`list ${prefix} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as StorageEntry[];
}

/**
 * Walk the bucket under `prefix`, collecting full paths of objects (leaves)
 * older than `cutoff`. Folders (id === null) are recursed. Object layout is
 * `<uid>/<sessionId>/<file>`, but the walk handles any depth.
 */
async function collectStale(prefix: string, cutoff: number, out: string[]): Promise<void> {
  let offset = 0;
  for (;;) {
    const page = await listPage(prefix, offset);
    if (page.length === 0) break;
    for (const entry of page) {
      const full = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.id === null) {
        await collectStale(full, cutoff, out); // folder
      } else {
        const ts = entry.created_at ? Date.parse(entry.created_at) : NaN;
        // Delete when older than cutoff. Unparseable timestamps are treated as
        // stale so nothing can hide from the sweep forever.
        if (Number.isNaN(ts) || ts < cutoff) out.push(full);
      }
    }
    if (page.length < LIST_PAGE) break;
    offset += page.length;
  }
}

async function removeBatch(paths: string[]): Promise<void> {
  const res = await fetch(`${base()}/storage/v1/object/${BUCKET}`, {
    method: "DELETE",
    headers: storageHeaders(),
    body: JSON.stringify({ prefixes: paths }),
  });
  if (!res.ok) throw new Error(`delete failed: ${res.status} ${await res.text()}`);
}

async function handle(req: Request): Promise<Response> {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !CLEANUP_SECRET) {
    return new Response("Function not configured", { status: 500 });
  }
  const provided = req.headers.get("x-cleanup-secret") ?? "";
  if (!secretsMatch(provided, CLEANUP_SECRET)) {
    return new Response("Forbidden", { status: 403 });
  }

  const cutoff = Date.now() - MAX_AGE_MS;
  const stale: string[] = [];
  await collectStale("", cutoff, stale);

  let deleted = 0;
  for (let i = 0; i < stale.length; i += DELETE_BATCH) {
    const batch = stale.slice(i, i + DELETE_BATCH);
    await removeBatch(batch);
    deleted += batch.length;
  }

  return new Response(JSON.stringify({ deleted }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(handle);
