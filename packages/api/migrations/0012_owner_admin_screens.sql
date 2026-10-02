-- Owner and admin screens: staff invitations and sign-in controls, client assignments, per-organisation
-- feature flags, invoice reminders that are scheduled and can be cancelled, and recorded WhatsApp consent.

-- Staff can exist before their first sign-in: invited, no password yet.
alter table users drop constraint staff_have_email_and_password;
alter table users add constraint staff_have_email check (auth_method <> 'email_password_totp' or email is not null);
alter table users add column whatsapp_consent_version text;

-- One-time links to set a password (new staff, or a reset requested by an admin). Reached only through
-- the functions below; the application role has no direct access.
create table staff_invites (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users (id),
  token_hash   text not null unique,
  expires_at   timestamptz not null,
  accepted_at  timestamptz,
  created_by   uuid not null references users (id),
  created_at   timestamptz not null default now()
);

-- Feature flags per organisation. No row means the application default (on).
create table org_features (
  org_id      uuid not null references organisations (id),
  feature     text not null check (feature in ('opening_balances', 'credit_invoices', 'record_payments', 'invoice_reminders', 'whatsapp_opt_in')),
  enabled     boolean not null,
  updated_by  uuid references users (id),
  updated_at  timestamptz not null default now(),
  primary key (org_id, feature)
);
alter table org_features enable row level security;
create policy tenant_isolation on org_features for all to vat_app
  using (org_id = any ((select app.scope_org_ids())::uuid[]))
  with check (org_id = any ((select app.scope_org_ids())::uuid[]));
grant select on org_features to vat_app;

-- Messages know whom they are for (consent is re-checked at send time) and which invoice they chase.
alter table outbound_messages add column user_id uuid references users (id);
alter table outbound_messages add column transaction_id uuid;
alter table outbound_messages drop constraint outbound_messages_status_check;
alter table outbound_messages add constraint outbound_messages_status_check
  check (status in ('queued', 'sent', 'delivered', 'failed', 'skipped', 'cancelled'));
create index outbound_messages_transaction on outbound_messages (transaction_id) where transaction_id is not null;

create or replace function app.is_platform_admin() returns boolean
language sql stable security definer set search_path = public, app as $$
  select exists (select 1 from memberships m join organisations o on o.id = m.org_id and o.is_platform
                 where m.user_id = app.current_user_id() and m.role = 'admin' and m.revoked_at is null)
$$;

create or replace function app.require_platform_admin() returns void
language plpgsql stable security definer set search_path = public, app as $$
begin
  if not app.is_platform_admin() then raise exception 'only Nex-Gen platform admins can do this' using errcode = '42501'; end if;
end $$;

create or replace function app.admin_invite_staff(p_email text, p_name text, p_role text, p_token_hash text, p_expires timestamptz)
returns uuid language plpgsql security definer set search_path = public, app as $$
declare
  v_platform uuid := (select id from organisations where is_platform);
  v_user uuid;
  v_method text;
begin
  perform app.require_platform_admin();
  if p_role not in ('reviewer', 'senior_reviewer', 'admin', 'support') then raise exception 'invalid staff role %', p_role; end if;
  select id, auth_method into v_user, v_method from users where email = p_email::citext;
  if v_user is null then
    insert into users (auth_method, email, full_name) values ('email_password_totp', p_email, p_name) returning id into v_user;
  elsif v_method <> 'email_password_totp' then
    raise exception 'this email belongs to a shop owner account';
  end if;
  insert into memberships (org_id, user_id, role) values (v_platform, v_user, p_role)
    on conflict (org_id, user_id, role) where revoked_at is null do nothing;
  update staff_invites set expires_at = now() where user_id = v_user and accepted_at is null and expires_at > now();
  insert into staff_invites (user_id, token_hash, expires_at, created_by) values (v_user, p_token_hash, p_expires, app.current_user_id());
  return v_user;
end $$;

-- Setting a password ends every existing session. Returns null for an unknown, used or expired link.
create or replace function app.accept_staff_invite(p_token_hash text, p_password_hash text) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare v_id uuid; v_user uuid;
begin
  select id, user_id into v_id, v_user from staff_invites
   where token_hash = p_token_hash and accepted_at is null and expires_at > now() for update;
  if v_id is null then return null; end if;
  update staff_invites set accepted_at = now() where id = v_id;
  update users set password_hash = p_password_hash where id = v_user;
  update auth_sessions set revoked_at = coalesce(revoked_at, now()) where user_id = v_user;
  return v_user;
end $$;

create or replace function app.admin_staff_list()
returns table (user_id uuid, email text, full_name text, roles text[], totp_enabled boolean, disabled boolean,
               invite_pending boolean, recovery_codes_left int, client_count int)
language plpgsql stable security definer set search_path = public, app as $$
begin
  perform app.require_platform_admin();
  return query
  select u.id, u.email::text, u.full_name,
         array_agg(distinct m.role order by m.role) filter (where m.org_id = p.id),
         u.totp_enabled_at is not null, u.disabled_at is not null, u.password_hash is null,
         coalesce(array_length(u.recovery_code_hashes, 1), 0),
         (select count(distinct m2.org_id)::int from memberships m2 where m2.user_id = u.id and m2.revoked_at is null and m2.org_id <> p.id)
  from users u
  join memberships m on m.user_id = u.id and m.revoked_at is null
  cross join (select id from organisations where is_platform) p
  where u.auth_method = 'email_password_totp'
  group by u.id, p.id
  order by u.full_name nulls last, u.email;
end $$;

create or replace function app.admin_reset_staff_2fa(p_user uuid) returns void
language plpgsql security definer set search_path = public, app as $$
begin
  perform app.require_platform_admin();
  update users set totp_secret_enc = null, totp_pending_enc = null, totp_enabled_at = null, recovery_code_hashes = '{}'
   where id = p_user and auth_method = 'email_password_totp';
  if not found then raise exception 'not a staff account'; end if;
  update auth_sessions set revoked_at = coalesce(revoked_at, now()) where user_id = p_user;
end $$;

-- Admin-issued recovery codes are temporary: one use, valid 24 hours, one live code per person.
create table staff_recovery_codes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id),
  code_hash   text not null,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_by  uuid not null references users (id),
  created_at  timestamptz not null default now()
);
create index staff_recovery_codes_live on staff_recovery_codes (user_id) where used_at is null;

create or replace function app.admin_add_recovery_code(p_user uuid, p_code_hash text) returns timestamptz
language plpgsql security definer set search_path = public, app as $$
declare v_expires timestamptz := now() + interval '24 hours';
begin
  perform app.require_platform_admin();
  if not exists (select 1 from users where id = p_user and auth_method = 'email_password_totp' and totp_enabled_at is not null) then
    raise exception 'recovery codes need an authenticator that is set up; reset 2FA instead';
  end if;
  update staff_recovery_codes set expires_at = least(expires_at, now()) where user_id = p_user and used_at is null;
  insert into staff_recovery_codes (user_id, code_hash, expires_at, created_by)
  values (p_user, p_code_hash, v_expires, app.current_user_id());
  return v_expires;
end $$;

-- Used by the sign-in step (auth context): true once per live, unexpired code.
create or replace function app.use_staff_recovery_code(p_user uuid, p_code_hash text) returns boolean
language plpgsql security definer set search_path = public, app as $$
declare v_id uuid;
begin
  select id into v_id from staff_recovery_codes
   where user_id = p_user and code_hash = p_code_hash and used_at is null and expires_at > now() for update;
  if v_id is null then return false; end if;
  update staff_recovery_codes set used_at = now() where id = v_id;
  return true;
end $$;
grant execute on function app.admin_add_recovery_code(uuid, text), app.use_staff_recovery_code(uuid, text) to vat_app;

create or replace function app.admin_set_staff_disabled(p_user uuid, p_disabled boolean) returns void
language plpgsql security definer set search_path = public, app as $$
begin
  perform app.require_platform_admin();
  if p_user = app.current_user_id() then raise exception 'you cannot disable your own account'; end if;
  update users set disabled_at = case when p_disabled then coalesce(disabled_at, now()) else null end
   where id = p_user and auth_method = 'email_password_totp';
  if not found then raise exception 'not a staff account'; end if;
  if p_disabled then update auth_sessions set revoked_at = coalesce(revoked_at, now()) where user_id = p_user; end if;
end $$;

create or replace function app.admin_unassign_staff(p_org uuid, p_user uuid) returns int
language plpgsql security definer set search_path = public, app as $$
declare n int;
begin
  perform app.require_platform_admin();
  if p_org = (select id from organisations where is_platform) then raise exception 'disable the account instead of removing platform roles'; end if;
  update memberships set revoked_at = now()
   where org_id = p_org and user_id = p_user and revoked_at is null and role in ('reviewer', 'senior_reviewer', 'admin', 'support');
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function app.admin_clients()
returns table (org_id uuid, org_name text, legal_name text, vat_number text, created_at timestamptz, staff jsonb, features jsonb)
language plpgsql stable security definer set search_path = public, app as $$
begin
  perform app.require_platform_admin();
  return query
  select o.id, coalesce(o.trading_name, o.legal_name), o.legal_name, o.vat_number, o.created_at,
         coalesce((select jsonb_agg(jsonb_build_object('userId', u.id, 'name', coalesce(u.full_name, u.email::text), 'email', u.email::text, 'role', m.role)
                                     order by m.role, u.full_name)
                   from memberships m join users u on u.id = m.user_id
                   where m.org_id = o.id and m.revoked_at is null and m.role in ('reviewer', 'senior_reviewer', 'admin', 'support')), '[]'::jsonb),
         coalesce((select jsonb_object_agg(f.feature, f.enabled) from org_features f where f.org_id = o.id), '{}'::jsonb)
  from organisations o
  where not o.is_platform
  order by 2;
end $$;

create or replace function app.admin_set_feature(p_org uuid, p_feature text, p_enabled boolean) returns void
language plpgsql security definer set search_path = public, app as $$
begin
  perform app.require_platform_admin();
  insert into org_features (org_id, feature, enabled, updated_by) values (p_org, p_feature, p_enabled, app.current_user_id())
  on conflict (org_id, feature) do update set enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = now();
end $$;

grant execute on function app.is_platform_admin(), app.require_platform_admin(),
  app.admin_invite_staff(text, text, text, text, timestamptz), app.accept_staff_invite(text, text), app.admin_staff_list(),
  app.admin_reset_staff_2fa(uuid), app.admin_add_recovery_code(uuid, text), app.admin_set_staff_disabled(uuid, boolean),
  app.admin_unassign_staff(uuid, uuid), app.admin_clients(), app.admin_set_feature(uuid, text, boolean) to vat_app;
