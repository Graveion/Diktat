-- Table-level privileges for the Supabase roles.
--
-- RLS controls *which rows* a role sees; GRANTs control whether the role may
-- touch the table at all. These weren't auto-applied (migrations ran as a
-- non-postgres role), so grant them explicitly.
--
--   authenticated  = the phone after login (RLS policies in 0001 filter to own rows)
--   service_role   = the relay (bypasses RLS; needs full table access for pairing)
--
-- anon is intentionally NOT granted: every path requires a logged-in user.

grant select, update, delete on public.machines to authenticated;
grant select, insert            on public.pairing_codes to authenticated;

grant all privileges on public.machines      to service_role;
grant all privileges on public.pairing_codes to service_role;
