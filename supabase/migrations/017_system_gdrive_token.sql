-- ─────────────────────────────────────────────────────────────────────────────
-- 017: System Google Drive Token (central coordinator account)
--
-- Stores exactly ONE row (singleton, id = 1) with the OAuth tokens for the
-- coordinator's central Google Drive account. All recording uploads use this
-- account regardless of which professor starts the recording.
--
-- Access model:
--   - Row is NEVER accessible via the public anon/user JWT.
--   - Only Netlify functions (which use the service_role key) can read/write.
--   - RLS deny-all policy for all public roles.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists system_gdrive_token (
  id            integer     primary key default 1 check (id = 1), -- enforces singleton
  access_token  text        not null,
  refresh_token text        not null,
  expires_at    bigint      not null,  -- epoch ms
  updated_at    timestamptz not null default now()
);

-- Only service_role can touch this table; deny all public access.
alter table system_gdrive_token enable row level security;

create policy "system_gdrive_deny_all"
  on system_gdrive_token
  for all
  using (false);
