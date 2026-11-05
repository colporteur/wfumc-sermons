-- =====================================================================
-- Claude connector (WFUMC Sermons): sign-in storage + change log
--
-- mcp_clients / mcp_tokens: the connector's own OAuth sign-in (same
--   design as the FIA connector). Tokens are stored only as SHA-256
--   hashes. RLS is ON with NO policies, so the browser apps (anon key)
--   can never read them; only the connector's direct connection can.
--
-- connector_changes: one row per write the connector makes, holding the
--   before/after state so any change can be undone (undo_change) and so
--   there is an audit trail of what Claude touched. Todd can read his
--   own rows from the app later if a "Claude changes" panel is added.
--
-- Copy into the Bulletin App's supabase/migrations folder and run
-- `supabase db push`.
-- =====================================================================

create table if not exists public.mcp_clients (
  id text primary key,
  name text,
  redirect_uris jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.mcp_tokens (
  id uuid primary key default gen_random_uuid(),
  client_id text not null,
  kind text not null check (kind in ('code', 'access', 'refresh')),
  token_hash text not null unique,
  grant_id uuid not null,
  scope text not null default 'read',
  code_challenge text,
  redirect_uri text,
  expires_at timestamptz not null,
  used_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists mcp_tokens_grant_idx on public.mcp_tokens (grant_id);

alter table public.mcp_clients enable row level security;
alter table public.mcp_tokens enable row level security;

create table if not exists public.connector_changes (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  tool text not null,
  sermon_id uuid references public.sermons(id) on delete set null,
  target_id uuid,
  summary text not null,
  before jsonb,
  after jsonb,
  revision_id uuid references public.sermon_revisions(id) on delete set null,
  client text,
  undone_at timestamptz,
  undone_by uuid references public.connector_changes(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists connector_changes_owner_idx
  on public.connector_changes (owner_user_id, created_at desc);
create index if not exists connector_changes_sermon_idx
  on public.connector_changes (sermon_id, created_at desc);

alter table public.connector_changes enable row level security;

drop policy if exists "Connector changes read by owner" on public.connector_changes;
create policy "Connector changes read by owner"
  on public.connector_changes for select
  using (auth.uid() = owner_user_id);
