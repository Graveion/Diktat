-- Billing / entitlement state (Phase 2).
--
-- Entitlement = pro (RevenueCat) OR comp (a redeemed friend code) OR within the
-- one-hour free-usage window. RevenueCat is checked client-side via its SDK;
-- the free-hour timer and comp access live here so they can't be reset by a
-- reinstall and codes can't be forged client-side.

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- account_state: one row per account holding trial + comp status.
-- Clients may READ their own row; all writes go through SECURITY DEFINER RPCs.
-- ---------------------------------------------------------------------------
create table public.account_state (
  account_id       uuid primary key references auth.users (id) on delete cascade,
  trial_started_at timestamptz,            -- set once, on first session
  comp_until       timestamptz,            -- comp access expiry ('infinity' = lifetime)
  created_at       timestamptz not null default now()
);

alter table public.account_state enable row level security;

create policy "account_state: owner reads"
  on public.account_state for select
  using (account_id = auth.uid());

grant select on public.account_state to authenticated;
grant all on public.account_state to service_role;

-- ---------------------------------------------------------------------------
-- comp_codes: hashed friend codes. No client access at all (RPC / service role).
-- ---------------------------------------------------------------------------
create table public.comp_codes (
  code_hash  text primary key,             -- sha256(code) hex
  label      text,
  grant_days int,                          -- null = lifetime
  max_uses   int not null default 1,
  uses       int not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.comp_codes enable row level security;
grant all on public.comp_codes to service_role;

create table public.comp_redemptions (
  account_id  uuid references auth.users (id) on delete cascade,
  code_hash   text references public.comp_codes (code_hash),
  redeemed_at timestamptz not null default now(),
  primary key (account_id, code_hash)
);

alter table public.comp_redemptions enable row level security;
grant select on public.comp_redemptions to authenticated;
grant all on public.comp_redemptions to service_role;

create policy "comp_redemptions: owner reads"
  on public.comp_redemptions for select
  using (account_id = auth.uid());

-- ---------------------------------------------------------------------------
-- start_trial(): stamp trial_started_at once (idempotent). Returns the start.
-- ---------------------------------------------------------------------------
create or replace function public.start_trial()
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare ts timestamptz;
begin
  insert into public.account_state (account_id, trial_started_at)
  values (auth.uid(), now())
  on conflict (account_id)
    do update set trial_started_at = coalesce(account_state.trial_started_at, now())
  returning trial_started_at into ts;
  return ts;
end;
$$;

grant execute on function public.start_trial() to authenticated;

-- ---------------------------------------------------------------------------
-- redeem_comp_code(code): validate a hashed code and grant comp access to the
-- caller. Idempotent per account. Server-side only — clients never see codes.
-- ---------------------------------------------------------------------------
create or replace function public.redeem_comp_code(code text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  h     text;
  c     public.comp_codes;
  grant_until timestamptz;
begin
  h := encode(digest(code, 'sha256'), 'hex');
  select * into c from public.comp_codes where code_hash = h and active;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'invalid code');
  end if;

  if not exists (
    select 1 from public.comp_redemptions where account_id = auth.uid() and code_hash = h
  ) then
    if c.uses >= c.max_uses then
      return jsonb_build_object('ok', false, 'error', 'code already used up');
    end if;
    insert into public.comp_redemptions (account_id, code_hash) values (auth.uid(), h);
    update public.comp_codes set uses = uses + 1 where code_hash = h;
  end if;

  grant_until := case
    when c.grant_days is null then 'infinity'::timestamptz
    else now() + make_interval(days => c.grant_days)
  end;

  insert into public.account_state (account_id, comp_until)
  values (auth.uid(), grant_until)
  on conflict (account_id)
    do update set comp_until = greatest(coalesce(account_state.comp_until, '-infinity'::timestamptz), excluded.comp_until);

  return jsonb_build_object('ok', true, 'comp_until', grant_until);
end;
$$;

grant execute on function public.redeem_comp_code(text) to authenticated;
