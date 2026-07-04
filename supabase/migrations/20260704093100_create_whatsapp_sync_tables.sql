begin;

create extension if not exists pgcrypto;
create extension if not exists pg_trgm;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create or replace function public.current_workspace_id()
returns text
language sql
stable
as $$
  select nullif(auth.jwt() ->> 'workspace_id', '');
$$;

create table if not exists public.whatsapp_contacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  connection_id text not null,
  jid text not null,
  phone text,
  display_name text,
  push_name text,
  profile_photo text,
  is_business boolean,
  last_seen timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint whatsapp_contacts_workspace_connection_jid_key unique (workspace_id, connection_id, jid)
);

create table if not exists public.whatsapp_conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  connection_id text not null,
  chat_jid text not null,
  contact_id uuid null,
  last_message text,
  last_message_type text,
  last_message_at timestamptz,
  unread_count integer not null default 0,
  is_group boolean not null default false,
  is_archived boolean not null default false,
  is_pinned boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint whatsapp_conversations_workspace_connection_chat_key unique (workspace_id, connection_id, chat_jid),
  constraint whatsapp_conversations_contact_id_fkey foreign key (contact_id) references public.whatsapp_contacts (id) on update cascade on delete set null
);

create table if not exists public.whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  conversation_id uuid not null,
  message_id text not null,
  sender_jid text,
  recipient_jid text,
  direction text not null,
  message_type text not null,
  text text,
  media_url text,
  status text not null,
  "timestamp" timestamptz not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint whatsapp_messages_workspace_conversation_message_key unique (workspace_id, conversation_id, message_id),
  constraint whatsapp_messages_conversation_id_fkey foreign key (conversation_id) references public.whatsapp_conversations (id) on update cascade on delete cascade,
  constraint whatsapp_messages_direction_check check (direction in ('inbound', 'outbound'))
);

create trigger set_whatsapp_contacts_updated_at
before update on public.whatsapp_contacts
for each row
execute function public.set_updated_at();

create trigger set_whatsapp_conversations_updated_at
before update on public.whatsapp_conversations
for each row
execute function public.set_updated_at();

create trigger set_whatsapp_messages_updated_at
before update on public.whatsapp_messages
for each row
execute function public.set_updated_at();

create index if not exists whatsapp_contacts_workspace_connection_idx
  on public.whatsapp_contacts (workspace_id, connection_id);

create index if not exists whatsapp_contacts_phone_idx
  on public.whatsapp_contacts (workspace_id, connection_id, phone);

create index if not exists whatsapp_contacts_updated_at_idx
  on public.whatsapp_contacts (workspace_id, connection_id, updated_at desc);

create index if not exists whatsapp_contacts_last_seen_idx
  on public.whatsapp_contacts (workspace_id, connection_id, last_seen desc nulls last);

create index if not exists whatsapp_contacts_jid_lookup_idx
  on public.whatsapp_contacts (workspace_id, connection_id, jid);

create index if not exists whatsapp_contacts_display_name_search_idx
  on public.whatsapp_contacts using gin (lower(coalesce(display_name, '')) gin_trgm_ops);

create index if not exists whatsapp_contacts_push_name_search_idx
  on public.whatsapp_contacts using gin (lower(coalesce(push_name, '')) gin_trgm_ops);

create index if not exists whatsapp_contacts_jid_search_idx
  on public.whatsapp_contacts using gin (lower(jid) gin_trgm_ops);

create index if not exists whatsapp_conversations_workspace_connection_idx
  on public.whatsapp_conversations (workspace_id, connection_id);

create index if not exists whatsapp_conversations_contact_lookup_idx
  on public.whatsapp_conversations (workspace_id, connection_id, contact_id);

create index if not exists whatsapp_conversations_chat_jid_lookup_idx
  on public.whatsapp_conversations (workspace_id, connection_id, chat_jid);

create index if not exists whatsapp_conversations_latest_message_idx
  on public.whatsapp_conversations (workspace_id, connection_id, last_message_at desc nulls last, updated_at desc);

create index if not exists whatsapp_conversations_last_message_search_idx
  on public.whatsapp_conversations using gin (lower(coalesce(last_message, '')) gin_trgm_ops);

create index if not exists whatsapp_conversations_chat_jid_search_idx
  on public.whatsapp_conversations using gin (lower(chat_jid) gin_trgm_ops);

create index if not exists whatsapp_messages_workspace_conversation_idx
  on public.whatsapp_messages (workspace_id, conversation_id);

create index if not exists whatsapp_messages_workspace_timestamp_idx
  on public.whatsapp_messages (workspace_id, "timestamp" desc);

create index if not exists whatsapp_messages_conversation_timestamp_idx
  on public.whatsapp_messages (conversation_id, "timestamp" desc);

create index if not exists whatsapp_messages_workspace_conversation_timestamp_idx
  on public.whatsapp_messages (workspace_id, conversation_id, "timestamp" desc);

create index if not exists whatsapp_messages_message_id_lookup_idx
  on public.whatsapp_messages (workspace_id, conversation_id, message_id);

create index if not exists whatsapp_messages_sender_lookup_idx
  on public.whatsapp_messages (workspace_id, conversation_id, sender_jid);

create index if not exists whatsapp_messages_latest_idx
  on public.whatsapp_messages (workspace_id, conversation_id, "timestamp" desc, created_at desc);

create index if not exists whatsapp_messages_text_search_idx
  on public.whatsapp_messages using gin (lower(coalesce(text, '')) gin_trgm_ops);

alter table public.whatsapp_contacts enable row level security;
alter table public.whatsapp_conversations enable row level security;
alter table public.whatsapp_messages enable row level security;

drop policy if exists whatsapp_contacts_select_own_workspace on public.whatsapp_contacts;
create policy whatsapp_contacts_select_own_workspace
on public.whatsapp_contacts
for select
to authenticated
using (workspace_id = public.current_workspace_id());

drop policy if exists whatsapp_contacts_insert_own_workspace on public.whatsapp_contacts;
create policy whatsapp_contacts_insert_own_workspace
on public.whatsapp_contacts
for insert
to authenticated
with check (workspace_id = public.current_workspace_id());

drop policy if exists whatsapp_contacts_update_own_workspace on public.whatsapp_contacts;
create policy whatsapp_contacts_update_own_workspace
on public.whatsapp_contacts
for update
to authenticated
using (workspace_id = public.current_workspace_id())
with check (workspace_id = public.current_workspace_id());

drop policy if exists whatsapp_contacts_delete_own_workspace on public.whatsapp_contacts;
create policy whatsapp_contacts_delete_own_workspace
on public.whatsapp_contacts
for delete
to authenticated
using (workspace_id = public.current_workspace_id());

drop policy if exists whatsapp_conversations_select_own_workspace on public.whatsapp_conversations;
create policy whatsapp_conversations_select_own_workspace
on public.whatsapp_conversations
for select
to authenticated
using (workspace_id = public.current_workspace_id());

drop policy if exists whatsapp_conversations_insert_own_workspace on public.whatsapp_conversations;
create policy whatsapp_conversations_insert_own_workspace
on public.whatsapp_conversations
for insert
to authenticated
with check (workspace_id = public.current_workspace_id());

drop policy if exists whatsapp_conversations_update_own_workspace on public.whatsapp_conversations;
create policy whatsapp_conversations_update_own_workspace
on public.whatsapp_conversations
for update
to authenticated
using (workspace_id = public.current_workspace_id())
with check (workspace_id = public.current_workspace_id());

drop policy if exists whatsapp_conversations_delete_own_workspace on public.whatsapp_conversations;
create policy whatsapp_conversations_delete_own_workspace
on public.whatsapp_conversations
for delete
to authenticated
using (workspace_id = public.current_workspace_id());

drop policy if exists whatsapp_messages_select_own_workspace on public.whatsapp_messages;
create policy whatsapp_messages_select_own_workspace
on public.whatsapp_messages
for select
to authenticated
using (workspace_id = public.current_workspace_id());

drop policy if exists whatsapp_messages_insert_own_workspace on public.whatsapp_messages;
create policy whatsapp_messages_insert_own_workspace
on public.whatsapp_messages
for insert
to authenticated
with check (workspace_id = public.current_workspace_id());

drop policy if exists whatsapp_messages_update_own_workspace on public.whatsapp_messages;
create policy whatsapp_messages_update_own_workspace
on public.whatsapp_messages
for update
to authenticated
using (workspace_id = public.current_workspace_id())
with check (workspace_id = public.current_workspace_id());

drop policy if exists whatsapp_messages_delete_own_workspace on public.whatsapp_messages;
create policy whatsapp_messages_delete_own_workspace
on public.whatsapp_messages
for delete
to authenticated
using (workspace_id = public.current_workspace_id());

grant select, insert, update, delete on public.whatsapp_contacts to authenticated;
grant select, insert, update, delete on public.whatsapp_conversations to authenticated;
grant select, insert, update, delete on public.whatsapp_messages to authenticated;

commit;
