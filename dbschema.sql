-- Create sessions table
create table if not exists sessions (
  id text primary key,
  pdf_path text not null,
  pdf_url text not null default '',
  filename text not null,
  total_slides integer not null,
  current_slide integer not null default 1,
  controller_token text not null,
  passphrase text not null,
  note_prefix text not null default 'note:',
  local boolean not null default false,
  user_id uuid references auth.users,
  -- Lifecycle: 'active' while the presentation is live; 'expired' once it has
  -- ended (either explicitly by the controller or after expires_at passed).
  -- Expired rows are retained as a record rather than deleted.
  status text not null default 'active',
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours')
);

-- For existing deployments: add the columns if the table predates them.
alter table sessions add column if not exists local boolean not null default true;
alter table sessions add column if not exists user_id uuid references auth.users;

-- "Bring your own storage": when set, the PDF is hosted externally (e.g. a
-- GitHub raw/Pages URL) and Presio stores only this URL — no bytes are uploaded
-- to the bucket. Mode is derivable: local=true ⇒ local; pdf_url <> '' ⇒
-- external; pdf_path <> '' ⇒ Supabase-hosted.
alter table sessions add column if not exists pdf_url text not null default '';
alter table sessions add column if not exists status text not null default 'active';

-- The timer became a device-local preference (never synced), so the settings
-- columns are gone. Drop them from deployments that predate the change.
alter table sessions drop column if exists timer_mode;
alter table sessions drop column if exists timer_duration;
alter table sessions drop column if exists timer_threshold;

-- sessions holds each deck's controller_token and passphrase, and the public
-- schema is exposed through PostgREST to anyone with the anon key (which ships
-- in the client bundle). Only the server touches this table, with the service
-- role key, which bypasses RLS; RLS with no policies keeps PostgREST clients
-- out. Idempotent, so safe on every boot.
alter table sessions enable row level security;

-- Index for cleanup query
create index if not exists idx_sessions_expires_at on sessions (expires_at);

-- Email list signups collected from the in-app prompt. Only the server (service
-- role) touches this table; RLS with no policies keeps PostgREST clients out.
create table if not exists newsletter_signups (
  email text primary key,
  created_at timestamptz not null default now()
);
alter table newsletter_signups enable row level security;

-- Create storage bucket for presentations
insert into storage.buckets (id, name, public)
values ('presentations', 'presentations', true)
on conflict (id) do nothing;

-- NOTE: the bucket is public, so every uploaded PDF is readable by anyone who
-- knows (or guesses) its object path. Do not store confidential material in
-- synced presentations.
--
-- Public buckets serve objects via /storage/v1/object/public/..., which does
-- not consult RLS, so no SELECT policy is needed to read PDFs. A SELECT policy
-- on storage.objects would only let anon clients list() the bucket and
-- enumerate every path, so we deliberately do not grant one. Drop the policy
-- earlier revisions created; the drop is idempotent and safe on every boot.
drop policy if exists "Public read access" on storage.objects;

-- Writes and deletes are performed exclusively by the server using the service
-- role key, which bypasses RLS. We deliberately do NOT grant anon/authenticated
-- insert or delete policies, so clients cannot tamper with stored PDFs directly.

-- If a deployment created the previously-permissive policies, drop them:
drop policy if exists "Allow uploads" on storage.objects;
drop policy if exists "Allow deletes" on storage.objects;
