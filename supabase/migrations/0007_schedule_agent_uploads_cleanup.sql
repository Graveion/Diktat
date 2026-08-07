-- Daily sweep of the agent-uploads Storage bucket (deletes objects >24h old).
-- The actual deletion is done by the `cleanup-agent-uploads` Edge Function (it
-- uses the Storage API so the S3 bytes are reclaimed, not orphaned). Here we
-- just schedule a daily HTTP call to it via pg_cron + pg_net.
--
-- No secrets/URLs are committed. The function URL and the shared secret are read
-- from database settings that you set ONCE per project (see supabase/README.md
-- "agent-uploads cleanup"):
--   alter database postgres set app.settings.functions_url  = 'https://<ref>.supabase.co/functions/v1';
--   alter database postgres set app.settings.cleanup_secret = '<same value as the CLEANUP_SECRET function secret>';
-- and:  supabase secrets set CLEANUP_SECRET=<that value>
--
-- If the settings are absent the job still runs but the POST is skipped (guarded
-- below), so a fresh project won't error before you've configured it.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Idempotent: drop a prior definition so re-applying the migration is safe.
select cron.unschedule('agent-uploads-cleanup')
where exists (select 1 from cron.job where jobname = 'agent-uploads-cleanup');

select cron.schedule(
  'agent-uploads-cleanup',
  '0 3 * * *',  -- 03:00 UTC daily
  $cron$
  select
    case
      when current_setting('app.settings.functions_url', true) is null
        or current_setting('app.settings.cleanup_secret', true) is null
      then null  -- not configured yet: skip quietly
      else net.http_post(
        url     := current_setting('app.settings.functions_url', true) || '/cleanup-agent-uploads',
        headers := jsonb_build_object(
          'Content-Type',    'application/json',
          'x-cleanup-secret', current_setting('app.settings.cleanup_secret', true)
        ),
        body    := '{}'::jsonb
      )
    end;
  $cron$
);
