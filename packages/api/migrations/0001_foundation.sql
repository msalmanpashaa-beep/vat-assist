-- Foundation: extensions, the app schema, request-context helpers and generic guards.
create extension if not exists pgcrypto;
create extension if not exists citext;
create extension if not exists btree_gist;

create schema if not exists app;
grant usage on schema app to vat_app;

-- Request context. The API sets these per transaction with set_config(..., true):
--   app.user_id  – authenticated user (uuid) or ''
--   app.org_id   – organisation the request targets, or '' for cross-org reads (reviewer portfolio)
--   app.context  – 'user' (default), 'system' (webhooks/jobs, must pin one org) or 'auth' (sign-in flows)
create or replace function app.current_user_id() returns uuid
language sql stable as $$ select nullif(current_setting('app.user_id', true), '')::uuid $$;

create or replace function app.current_org_id() returns uuid
language sql stable as $$ select nullif(current_setting('app.org_id', true), '')::uuid $$;

create or replace function app.current_context() returns text
language sql stable as $$ select coalesce(nullif(current_setting('app.context', true), ''), 'user') $$;

-- Generic guard for append-only tables.
create or replace function app.forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'immutable_row: % on % is not allowed', tg_op, tg_table_name using errcode = 'P0001';
end $$;

-- Lower-case, strip punctuation and common legal suffixes, collapse spaces. Used to match supplier names.
create or replace function app.normalise_name(p text) returns text
language sql immutable parallel safe as $$
  select btrim(regexp_replace(
           regexp_replace(
             regexp_replace(lower(coalesce(p, '')), '[^a-z0-9 ]+', ' ', 'g'),
             '\m(ltd|limited|ltee|ltée|co|cie|company|sarl|plc|inc)\M', ' ', 'g'),
           '\s+', ' ', 'g'))
$$;
