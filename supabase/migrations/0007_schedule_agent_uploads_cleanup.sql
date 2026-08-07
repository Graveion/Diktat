-- Daily sweep of the agent-uploads Storage bucket (deletes objects >24h old).
-- The actual deletion is done by the `cleanup-agent-uploads` Edge Function (it
-- uses the Storage API so the S3 bytes are reclaimed, not orphaned). Here we
-- just schedule a daily HTTP call to it via pg_cron + pg_net.
--
-- No secrets/URLs are committed. They live in Supabase Vault (the SQL editor can
-- write to Vault; `alter database … set` is permission-denied on hosted
-- projects, so we use Vault rather than GUCs). Set them ONCE per project — see
-- supabase/README.md "agent-uploads cleanup":
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1/cleanup-agent-uploads', 'agent_uploads_cleanup_url');
--   select vault.create_secret('<same value as the CLEANUP_SECRET function secret>', 'agent_uploads_cleanup_secret');
-- and:  supabase secrets set CLEANUP_SECRET=<that value>
--
-- If the Vault entries are absent the job still runs but the POST is skipped
-- (guarded below), so a fresh project won't error before you've configured it.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Idempotent: drop a prior definition so re-applying the migration is safe.
select cron.unschedule('agent-uploads-cleanup')
where exists (select 1 from cron.job where jobname = 'agent-uploads-cleanup');

select cron.schedule(
  'agent-uploads-cleanup',
  '0 3 * * *',  -- 03:00 UTC daily
  $cron$
  with cfg as (
    select
      (select decrypted_secret from vault.decrypted_secrets where name = 'agent_uploads_cleanup_url')    as url,
      (select decrypted_secret from vault.decrypted_secrets where name = 'agent_uploads_cleanup_secret') as secret
  )
  select
    case
      when cfg.url is null or cfg.secret is null
      then null  -- not configured yet: skip quietly
      else net.http_post(
        url     := cfg.url,
        headers := jsonb_build_object(
          'Content-Type',     'application/json',
          'x-cleanup-secret', cfg.secret
        ),
        body    := '{}'::jsonb
      )
    end
  from cfg;
  $cron$
);
