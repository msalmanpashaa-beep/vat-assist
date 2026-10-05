-- Pilot measurement: a referral code per business (and who referred whom), and a pilot cohort tag.
alter table organisations add column referral_code text unique check (referral_code ~ '^NX[0-9A-Z]{6}$');
alter table organisations add column referred_by_org_id uuid references organisations (id);
alter table organisations add column pilot_cohort text check (pilot_cohort ~ '^[a-z0-9-]{1,40}$');
update organisations set referral_code = 'NX' || upper(substr(md5(id::text), 1, 6)) where not is_platform and referral_code is null;

-- A new business quotes another shop's code; this finds that shop without exposing any other data.
create or replace function app.org_by_referral_code(p_code text) returns uuid
language sql stable security definer set search_path = public, app as $$
  select id from organisations where referral_code = upper(trim(p_code)) and not is_platform
$$;

create or replace function app.admin_set_pilot_cohort(p_org uuid, p_cohort text) returns void
language plpgsql security definer set search_path = public, app as $$
begin
  perform app.require_platform_admin();
  update organisations set pilot_cohort = p_cohort where id = p_org and not is_platform;
  if not found then raise exception 'no such business'; end if;
end $$;

-- Everything the pilot scorecard needs, per business, for platform admins only. Staff actions (Nex-Gen
-- reviewers) in the window feed the reviewer-minutes estimate; owner actions give the last activity.
create or replace function app.admin_pilot_data(p_cohort text, p_from timestamptz, p_to timestamptz)
returns table (
  org_id uuid, org_name text, cohort text, signed_up_at timestamptz, files_electronically boolean,
  opening_at timestamptz, docs_14d int, sales_14d int, last_owner_activity timestamptz,
  staff_action_times timestamptz[], periods jsonb, referrals int, subscription_status text
)
language plpgsql stable security definer set search_path = public, app as $$
begin
  perform app.require_platform_admin();
  return query
  select o.id, coalesce(o.trading_name, o.legal_name), o.pilot_cohort, o.created_at, o.files_and_pays_electronically,
         (select min(a.occurred_at) from audit_events a where a.org_id = o.id and a.action = 'org.opening_balances'),
         (select count(*)::int from documents d where d.org_id = o.id and d.created_at < o.created_at + interval '14 days'),
         (select count(*)::int from transactions t where t.org_id = o.id and t.kind in ('daily_takings', 'sales_invoice')
             and t.status = 'posted' and t.created_at < o.created_at + interval '14 days'),
         (select max(a.occurred_at) from audit_events a join users u on u.id = a.actor_user_id
           where a.org_id = o.id and u.auth_method = 'phone_otp'),
         coalesce((select array_agg(a.occurred_at order by a.occurred_at) from audit_events a join users u on u.id = a.actor_user_id
           where a.org_id = o.id and u.auth_method = 'email_password_totp' and a.occurred_at >= p_from and a.occurred_at < p_to),
           '{}'::timestamptz[]),
         coalesce((select jsonb_agg(jsonb_build_object(
             'periodId', p.id, 'startsOn', p.starts_on, 'endsOn', p.ends_on, 'dueOn', p.due_on, 'extendedDueOn', p.extended_due_on,
             'status', p.status, 'filedAt', (select max(r.filed_at) from vat_returns r where r.period_id = p.id)) order by p.starts_on)
           from vat_periods p where p.org_id = o.id), '[]'::jsonb),
         (select count(*)::int from organisations x where x.referred_by_org_id = o.id),
         (select s.status from subscriptions s where s.org_id = o.id limit 1)
  from organisations o
  where not o.is_platform and (p_cohort is null or o.pilot_cohort = p_cohort)
  order by o.created_at;
end $$;

grant execute on function app.org_by_referral_code(text), app.admin_set_pilot_cohort(uuid, text),
  app.admin_pilot_data(text, timestamptz, timestamptz) to vat_app;
