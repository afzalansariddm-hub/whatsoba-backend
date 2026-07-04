begin;

create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  name text not null,
  key_hash text not null,
  prefix text not null,
  status text not null default 'active',
  created_at timestamptz not null default timezone('utc', now()),
  last_used_at timestamptz null,
  created_by text null,
  constraint api_keys_status_check check (status in ('active', 'disabled'))
);

create unique index if not exists api_keys_key_hash_key
  on public.api_keys (key_hash);

create unique index if not exists api_keys_workspace_active_key
  on public.api_keys (workspace_id)
  where status = 'active';

create index if not exists api_keys_workspace_idx
  on public.api_keys (workspace_id);

create index if not exists api_keys_prefix_idx
  on public.api_keys (prefix);

create index if not exists api_keys_status_idx
  on public.api_keys (workspace_id, status);

commit;
