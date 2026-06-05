#!/usr/bin/env bun
//
// ADMIN ONLY — mint a comp (complimentary access) code.
//
// Security model: this writes to public.comp_codes, which is service-role only
// (RLS blocks everyone else). It requires SUPABASE_SECRET_KEY — the service key
// — which lives in relay/.env (gitignored) and on Fly. Cloning this file is
// useless without that secret, so the public repo can't be used to forge codes.
// This is NOT part of the user-facing `diktat` CLI and must never ship to users.
//
// Usage (from relay/, Bun auto-loads relay/.env):
//   bun mint-comp.ts "alice"                 # lifetime, single use
//   bun mint-comp.ts "beta wave" --days 30 --uses 50
//   bun mint-comp.ts "fixed" --code DIKTATXMAS --days 90
//
import { createHash, randomInt } from "node:crypto";

const URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SECRET_KEY;
if (!URL || !KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_SECRET_KEY (set them in relay/.env).");
  process.exit(1);
}

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const label = args.find((a) => !a.startsWith("--")) ?? "comp";
const daysArg = flag("--days");
const days = daysArg ? Number(daysArg) : null; // null = lifetime
const uses = flag("--uses") ? Number(flag("--uses")) : 1;

function genCode(): string {
  // No ambiguous chars (0/O/1/I/L), so codes are easy to read out / type.
  const alpha = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 10; i++) s += alpha[randomInt(alpha.length)];
  return s;
}

const code = flag("--code") ?? genCode();
const code_hash = createHash("sha256").update(code).digest("hex");

const res = await fetch(`${URL.replace(/\/$/, "")}/rest/v1/comp_codes`, {
  method: "POST",
  headers: {
    apikey: KEY,
    Authorization: `Bearer ${KEY}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  },
  body: JSON.stringify({ code_hash, label, grant_days: days, max_uses: uses, active: true }),
});

if (!res.ok) {
  console.error("Failed:", res.status, await res.text());
  process.exit(1);
}

console.log(`\n  Comp code:  ${code}`);
console.log(`  label=${label}  grant=${days === null ? "lifetime" : days + "d"}  max_uses=${uses}\n`);
console.log("  Redeem in-app: paywall → “Have a code?” → enter the code.\n");
