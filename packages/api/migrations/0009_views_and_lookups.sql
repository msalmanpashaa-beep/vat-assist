-- Open items for ageing. security_invoker makes the view obey the caller's RLS.
create view v_open_items with (security_invoker = true) as
select t.org_id,
       t.id as transaction_id,
       t.kind,
       t.open_item_side as side,
       t.contact_id,
       c.name as contact_name,
       t.reference,
       t.issue_date,
       t.due_date,
       t.gross_cents,
       (t.gross_cents - coalesce(a.allocated, 0))::bigint as outstanding_cents
from transactions t
left join contacts c on c.id = t.contact_id
left join lateral (select sum(amount_cents) as allocated from allocations al where al.invoice_transaction_id = t.id) a on true
where t.status = 'posted' and t.settlement = 'credit' and t.open_item_side is not null;
grant select on v_open_items to vat_app;

-- Narrow cross-organisation lookups for background jobs and webhooks. They return identifiers only;
-- the work itself then runs in 'system' context pinned to one organisation.
create or replace function app.reminder_vat_candidates(p_target date)
returns table (org_id uuid, period_id uuid, deadline_kind text, due_on date)
language sql stable security definer set search_path = public, app as $$
  select p.org_id, p.id, 'standard', p.due_on
  from vat_periods p
  where p.status in ('open', 'in_review', 'signed_off') and p.due_on = p_target
  union all
  select p.org_id, p.id, 'electronic', p.extended_due_on
  from vat_periods p join organisations o on o.id = p.org_id
  where o.files_and_pays_electronically and p.extended_due_on <> p.due_on
    and p.status in ('open', 'in_review', 'signed_off') and p.extended_due_on = p_target
$$;

create or replace function app.reminder_booking_candidates(p_from timestamptz, p_to timestamptz)
returns table (org_id uuid, booking_id uuid)
language sql stable security definer set search_path = public, app as $$
  select b.org_id, b.id from bookings b
  where b.status = 'confirmed' and b.starts_at >= p_from and b.starts_at < p_to
$$;

create or replace function app.reminder_invoice_candidates(p_target date)
returns table (org_id uuid, transaction_id uuid)
language sql stable security definer set search_path = public, app as $$
  select t.org_id, t.id
  from transactions t
  join organisations o on o.id = t.org_id and o.debtor_reminders_enabled
  join contacts c on c.id = t.contact_id and c.phone_e164 is not null and c.reminder_consent_at is not null
  where t.kind = 'sales_invoice' and t.status = 'posted' and t.settlement = 'credit' and t.due_date = p_target
    and t.gross_cents > coalesce((select sum(amount_cents) from allocations a where a.invoice_transaction_id = t.id), 0)
$$;

create or replace function app.payment_org(p_payment uuid) returns uuid
language sql stable security definer set search_path = public, app as $$
  select org_id from payments where id = p_payment
$$;

create or replace function app.outbound_message_org(p_sid text) returns uuid
language sql stable security definer set search_path = public, app as $$
  select org_id from outbound_messages where provider_sid = p_sid
$$;

create or replace function app.queued_message_orgs(p_now timestamptz)
returns table (org_id uuid)
language sql stable security definer set search_path = public, app as $$
  select distinct org_id from outbound_messages where status = 'queued' and scheduled_for <= p_now
$$;

grant execute on all functions in schema app to vat_app;
