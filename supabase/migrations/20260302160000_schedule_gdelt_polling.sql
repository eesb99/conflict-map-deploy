-- Dedup index for fast source_url lookups during ingestion
CREATE INDEX IF NOT EXISTS idx_events_source_url ON osint_events(source_url);

-- Enable extensions for scheduled function invocation
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA pg_catalog;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Store service_role key in Vault for secure access from pg_net
-- NOTE: Replace YOUR_SERVICE_ROLE_KEY with the actual key before running.
-- Run manually: SELECT vault.create_secret('YOUR_SERVICE_ROLE_KEY', 'service_role_key');

-- Schedule poll-gdelt Edge Function every 15 minutes
SELECT cron.schedule(
  'poll-gdelt-every-15min',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.settings.supabase_url') || '/functions/v1/poll-gdelt',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- To verify cron is running:
-- SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 5;
