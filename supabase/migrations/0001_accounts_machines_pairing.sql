-- Diktat accounts / machines / pairing schema (Phase 1).
--
-- Identity = Supabase Auth (`auth.users`). An "account" IS an auth user; we never
-- create a separate accounts table. accountId == auth.users.id (uuid).
--
-- This replaces the static relay-config.json registry:
--   machines{ id -> { daemonToken, accountId } }  →  public.machines
--   accountTokens{ token -> accountId }            →  the Supabase JWT (sub = accountId)
--
-- The relay verifies the phone's account token by validating the Supabase JWT
-- (no table lookup). It verifies a daemon's per-machine token by hashing it and
-- matching machines.token_hash. Ownership = machines.account_id == JWT.sub.

-- ---------------------------------------------------------------------------
-- machines: a dev machine running the Diktat daemon, owned by one account.
-- ---------------------------------------------------------------------------
create table public.machines (
  id           text primary key,                                   -- stable machineId (daemon-generated)
  account_id   uuid not null references auth.users (id) on delete cascade,
  name         text not null default 'My Mac',
  token_hash   text not null,                                      -- sha256(daemon token); plaintext never stored
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz
);

create index machines_account_id_idx on public.machines (account_id);

-- ---------------------------------------------------------------------------
-- pairing_codes: short-lived codes minted by the phone, redeemed by the daemon.
-- ---------------------------------------------------------------------------
create table public.pairing_codes (
  code        text primary key,                                    -- short, human-typable (e.g. 8 chars)
  account_id  uuid not null references auth.users (id) on delete cascade,
  expires_at  timestamptz not null,
  consumed_at timestamptz,                                         -- set when a daemon redeems it
  machine_id  text references public.machines (id) on delete set null,
  created_at  timestamptz not null default now()
);

create index pairing_codes_account_id_idx on public.pairing_codes (account_id);

-- ---------------------------------------------------------------------------
-- Row Level Security
--   - The phone (authenticated, anon/JWT) manages its OWN rows only.
--   - The relay uses the service-role key, which BYPASSES RLS, for the writes
--     that must be trusted: minting machines + consuming codes during pairing,
--     and reading token_hash at agent-auth time.
-- ---------------------------------------------------------------------------
alter table public.machines enable row level security;
alter table public.pairing_codes enable row level security;

-- machines: owner can see, rename, and unpair their machines. Inserts are
-- relay-only (service role) — a phone never writes a token_hash.
create policy "machines: owner can read"
  on public.machines for select
  using (account_id = auth.uid());

create policy "machines: owner can rename"
  on public.machines for update
  using (account_id = auth.uid())
  with check (account_id = auth.uid());

create policy "machines: owner can unpair"
  on public.machines for delete
  using (account_id = auth.uid());

-- pairing_codes: owner can create a code for themselves and read their own.
-- Consuming (update) is relay-only (service role).
create policy "pairing_codes: owner can create"
  on public.pairing_codes for insert
  with check (account_id = auth.uid());

create policy "pairing_codes: owner can read"
  on public.pairing_codes for select
  using (account_id = auth.uid());
