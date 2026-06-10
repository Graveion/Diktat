-- Product analytics + in-app feedback.
--
-- First-party, PII-free usage events and user-submitted feedback. The client
-- only ever INSERTs (authenticated, own rows); reading is service-role/dashboard
-- only. account_id is the auth uid (no FK — analytics needs no referential
-- integrity and we never join from the client).

create table if not exists events (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid,
  name        text not null,
  props       jsonb not null default '{}'::jsonb,
  platform    text,
  app_version text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_events_account on events (account_id, created_at desc);
create index if not exists idx_events_name on events (name, created_at desc);

create table if not exists feedback (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid,
  message     text not null,
  kind        text not null default 'other',
  crash       text,
  platform    text,
  app_version text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_feedback_created on feedback (created_at desc);

alter table events enable row level security;
alter table feedback enable row level security;

-- Authenticated users may insert only their own rows. No SELECT policy → the
-- anon/auth client cannot read events or feedback back (inspect server-side).
drop policy if exists events_insert_own on events;
create policy events_insert_own on events
  for insert to authenticated with check (account_id = auth.uid());

drop policy if exists feedback_insert_own on feedback;
create policy feedback_insert_own on feedback
  for insert to authenticated with check (account_id = auth.uid());
