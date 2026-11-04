-- The cron jobs read their X-Cleanup-Key from Supabase Vault instead of carrying it in plain text
-- (2026-11-04). 0014 wrote the key into this public repo, where it stayed live for months; 0018 and
-- 0020 then copied it forward from the job's own command, so one rotation had to touch three places.
-- Now it lives in two: the Vault secret below and the CLEANUP_STORAGE_KEY function secret.
--
-- Run ONLY after the Vault secret 'cron_internal_key' exists, or these jobs send a null key. The
-- value is never written in a migration. To rotate: update the Vault secret and the function secret
-- together, nothing else.

select cron.schedule(
  'cleanup-design-mockups-storage',
  '41 4 * * *',
  $$
  select net.http_post(
    url := 'https://fgrhbzqzadpjpbzuszpm.supabase.co/functions/v1/cleanup-storage',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Cleanup-Key', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_internal_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  )
  $$
);

select cron.schedule(
  'order-watchdog',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://fgrhbzqzadpjpbzuszpm.supabase.co/functions/v1/order-watchdog',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'X-Cleanup-Key', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_internal_key')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  )
  $$
);
