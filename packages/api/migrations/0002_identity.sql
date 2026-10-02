-- Organisations, people, memberships and sessions.
create table organisations (
  id                             uuid primary key default gen_random_uuid(),
  legal_name                     text not null,
  trading_name                   text,
  legal_form                     text not null check (legal_form in ('sole_trader', 'company', 'partnership', 'other')),
  brn                            text,
  vat_number                     text check (vat_number is null or vat_number ~ '^[0-9]{8}$'),
  vat_registered_on              date,
  filing_frequency               text not null default 'quarterly' check (filing_frequency in ('monthly', 'quarterly')),
  files_and_pays_electronically  boolean not null default true,
  start_date                     date not null,
  shop_type                      text,
  default_locale                 text not null default 'en' check (default_locale in ('en', 'fr', 'mfe')),
  is_platform                    boolean not null default false,
  debtor_reminders_enabled       boolean not null default false,
  opening_vat_credit_cents       bigint not null default 0 check (opening_vat_credit_cents >= 0),
  created_at                     timestamptz not null default now()
);
create unique index organisations_one_platform on organisations (is_platform) where is_platform;

create table users (
  id                  uuid primary key default gen_random_uuid(),
  auth_method         text not null check (auth_method in ('phone_otp', 'email_password_totp')),
  full_name           text,
  phone_e164          text unique check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  email               citext unique,
  password_hash       text,
  totp_secret_enc     text,
  totp_pending_enc    text,
  totp_enabled_at     timestamptz,
  recovery_code_hashes text[] not null default '{}',
  locale              text not null default 'en' check (locale in ('en', 'fr', 'mfe')),
  whatsapp_opt_in_at  timestamptz,
  sms_opt_out_at      timestamptz,
  disabled_at         timestamptz,
  created_at          timestamptz not null default now(),
  constraint phone_users_have_phone check (auth_method <> 'phone_otp' or phone_e164 is not null),
  constraint staff_have_email_and_password check (auth_method <> 'email_password_totp' or (email is not null and password_hash is not null))
);

create table memberships (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organisations (id),
  user_id     uuid not null references users (id),
  role        text not null check (role in ('owner', 'staff', 'reviewer', 'senior_reviewer', 'admin', 'support')),
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);
create unique index memberships_active_uq on memberships (org_id, user_id, role) where revoked_at is null;
create index memberships_user_idx on memberships (user_id) where revoked_at is null;

create table auth_sessions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references users (id),
  family_id           uuid not null,
  refresh_token_hash  text not null unique,
  created_at          timestamptz not null default now(),
  expires_at          timestamptz not null,
  revoked_at          timestamptz,
  replaced_by         uuid,
  user_agent          text,
  ip                  inet
);
create index auth_sessions_family_idx on auth_sessions (family_id);

-- Which organisations the current request may touch. SECURITY DEFINER so it can read memberships
-- without recursing into memberships' own policy. In 'system' context it is pinned to one org.
create or replace function app.scope_org_ids() returns uuid[]
language sql stable security definer set search_path = public, app as $$
  select case
    when app.current_context() = 'system' then
      case when app.current_org_id() is null then '{}'::uuid[] else array[app.current_org_id()] end
    else coalesce((
      select array_agg(distinct m.org_id)
      from memberships m
      where m.user_id = app.current_user_id()
        and m.revoked_at is null
        and (app.current_org_id() is null or m.org_id = app.current_org_id())
    ), '{}'::uuid[])
  end
$$;

create or replace function app.has_role(p_org uuid, p_roles text[]) returns boolean
language sql stable security definer set search_path = public, app as $$
  select exists (
    select 1 from memberships m
    where m.org_id = p_org and m.user_id = app.current_user_id() and m.revoked_at is null and m.role = any (p_roles)
  )
$$;

-- Owner onboarding: creates the organisation and the caller's owner membership in one step.
create or replace function app.create_org_with_owner(p jsonb) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  v_user uuid := app.current_user_id();
  v_org uuid;
begin
  if v_user is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  insert into organisations (legal_name, trading_name, legal_form, brn, vat_number, vat_registered_on,
                             filing_frequency, files_and_pays_electronically, start_date, shop_type, default_locale)
  values (p->>'legalName', p->>'tradingName', p->>'legalForm', p->>'brn', p->>'vatNumber', (p->>'vatRegisteredOn')::date,
          coalesce(p->>'filingFrequency', 'quarterly'), coalesce((p->>'filesAndPaysElectronically')::boolean, true),
          (p->>'startDate')::date, p->>'shopType', coalesce(p->>'defaultLocale', 'en'))
  returning id into v_org;
  insert into memberships (org_id, user_id, role) values (v_org, v_user, 'owner');
  return v_org;
end $$;

-- Platform admins assign Nex-Gen reviewers to client organisations.
create or replace function app.assign_staff(p_org uuid, p_user uuid, p_role text) returns uuid
language plpgsql security definer set search_path = public, app as $$
declare
  v_platform uuid := (select id from organisations where is_platform);
  v_id uuid;
begin
  if p_role not in ('reviewer', 'senior_reviewer', 'admin', 'support') then raise exception 'invalid_role'; end if;
  if not exists (select 1 from memberships where org_id = v_platform and user_id = app.current_user_id()
                 and role = 'admin' and revoked_at is null) then
    raise exception 'only_platform_admins_can_assign' using errcode = '42501';
  end if;
  insert into memberships (org_id, user_id, role) values (p_org, p_user, p_role)
  on conflict (org_id, user_id, role) where revoked_at is null do update set role = excluded.role
  returning id into v_id;
  return v_id;
end $$;
