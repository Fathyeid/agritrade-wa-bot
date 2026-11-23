-- Run once in the Supabase SQL editor on the AgriTrade project.
-- The bot connects with the service role key, which bypasses RLS,
-- so no extra grants are needed and anon/authenticated users get nothing.

create table if not exists wa_auth_files (
  filename text primary key,
  content text not null,
  updated_at timestamptz not null default now()
);

create table if not exists wa_subscribers (
  phone text primary key,
  name text,
  active boolean not null default true,
  opted_in_at timestamptz not null default now(),
  last_seen_at timestamptz
);

create table if not exists wa_questions (
  id bigint generated always as identity primary key,
  phone text not null,
  question text not null,
  answer text,
  answered boolean not null default false,
  created_at timestamptz not null default now()
);

alter table wa_auth_files enable row level security;
alter table wa_subscribers enable row level security;
alter table wa_questions enable row level security;
-- No policies: only the service role (the bot) can read or write.
