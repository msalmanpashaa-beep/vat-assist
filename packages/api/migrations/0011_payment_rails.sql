-- Local payment rails. A payment request is what someone owes and how they can pay it; payments are the
-- attempts and receipts against it: card checkouts (MIPS, Stripe) confirmed by the provider's callback,
-- and Juice / bank transfers claimed by the payer and confirmed by the payee once the money is seen.

create table payment_settings (
  org_id               uuid primary key references organisations (id),
  juice_mobile         text check (juice_mobile ~ '^\+2305\d{7}$'),
  juice_name           text,
  bank_name            text,
  bank_account_name    text,
  bank_account_number  text check (bank_account_number ~ '^[0-9 -]{6,30}$'),
  bank_iban            text check (bank_iban ~ '^MU\d{2}[A-Z0-9]{26}$'),
  qr_document_id       uuid references documents (id),
  card_provider        text check (card_provider in ('mips', 'stripe')),
  updated_by           uuid references users (id),
  updated_at           timestamptz not null default now()
);

create table payment_requests (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organisations (id),
  payer_org_id    uuid references organisations (id),
  payable_kind    text not null check (payable_kind in ('invoice', 'booking')),
  payable_id      uuid not null,
  reference       text not null check (reference ~ '^VA[0-9A-Z]{6}$'),
  token_hash      text not null unique,
  amount_cents    bigint not null check (amount_cents > 0),
  currency        char(3) not null default 'MUR',
  payee_name      text not null,
  payer_name      text,
  description     text not null,
  status          text not null default 'open' check (status in ('open', 'paid', 'cancelled', 'expired')),
  expires_at      timestamptz not null,
  created_by      uuid references users (id),
  created_at      timestamptz not null default now(),
  paid_at         timestamptz,
  unique (org_id, reference)
);
create index payment_requests_payable on payment_requests (payable_kind, payable_id);

alter table payments add column payment_request_id uuid references payment_requests (id);
alter table payments add column payer_reference text;
alter table payments add column proof_document_id uuid references documents (id);
alter table payments add column received_on date;
alter table payments add column confirmed_by uuid references users (id);
alter table payments add column confirmed_at timestamptz;
alter table payments add column rejection_reason text;
alter table payments drop constraint payments_status_check;
alter table payments add constraint payments_status_check
  check (status in ('pending', 'awaiting_confirmation', 'succeeded', 'failed', 'expired', 'rejected', 'refunded'));
alter table payments add constraint payments_provider_check check (provider in ('stripe', 'mips', 'juice', 'bank_transfer', 'mock'));
create index payments_awaiting on payments (org_id) where status = 'awaiting_confirmation';

alter table transactions drop constraint transactions_payment_method_check;
alter table transactions add constraint transactions_payment_method_check
  check (payment_method in ('cash', 'bank', 'juice', 'card', 'stripe', 'mips'));

-- New clearing account for MIPS settlements, for organisations that already exist.
insert into accounts (org_id, code, name, type, system_tag)
select id, '1050', 'MIPS payments (clearing)', 'asset', 'mips_clearing' from organisations
on conflict do nothing;

alter table payment_settings enable row level security;
create policy tenant_isolation on payment_settings for all to vat_app
  using (org_id = any ((select app.scope_org_ids())::uuid[]))
  with check (org_id = any ((select app.scope_org_ids())::uuid[]));
alter table payment_requests enable row level security;
create policy payment_requests_parties on payment_requests for all to vat_app
  using (org_id = any ((select app.scope_org_ids())::uuid[]) or payer_org_id = any ((select app.scope_org_ids())::uuid[]))
  with check (org_id = any ((select app.scope_org_ids())::uuid[]) or payer_org_id = any ((select app.scope_org_ids())::uuid[]));
grant select, insert, update on payment_settings, payment_requests to vat_app;

-- Public pay links and provider callbacks arrive without a signed-in user: these narrow lookups find
-- the organisation, and the caller then works pinned to it.
create or replace function app.payment_request_by_token(p_token_hash text) returns table (id uuid, org_id uuid)
language sql stable security definer set search_path = public, app as $$
  select id, org_id from payment_requests where token_hash = p_token_hash
$$;
create or replace function app.payment_by_provider_ref(p_provider text, p_ref text) returns table (id uuid, org_id uuid)
language sql stable security definer set search_path = public, app as $$
  select id, org_id from payments where provider = p_provider and provider_session_id = p_ref
$$;
grant execute on function app.payment_request_by_token(text), app.payment_by_provider_ref(text, text) to vat_app;
