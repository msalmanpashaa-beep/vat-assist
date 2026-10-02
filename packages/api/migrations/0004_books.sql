-- The books: chart of accounts, contacts, VAT periods, documents, transactions and the double-entry ledger.
create table org_counters (
  org_id  uuid not null references organisations (id),
  name    text not null,
  value   bigint not null default 0,
  primary key (org_id, name)
);

create or replace function app.next_counter(p_org uuid, p_name text) returns bigint
language plpgsql as $$
declare v bigint;
begin
  insert into org_counters (org_id, name, value) values (p_org, p_name, 1)
  on conflict (org_id, name) do update set value = org_counters.value + 1
  returning value into v;
  return v;
end $$;

create table accounts (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organisations (id),
  code        text not null,
  name        text not null,
  type        text not null check (type in ('asset', 'liability', 'equity', 'income', 'expense')),
  system_tag  text,
  is_active   boolean not null default true,
  unique (org_id, code),
  unique (org_id, system_tag),
  unique (id, org_id)
);

create table contacts (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organisations (id),
  kind                text not null check (kind in ('customer', 'supplier', 'both')),
  name                text not null,
  name_normalised     text generated always as (app.normalise_name(name)) stored,
  vat_number          text,
  brn                 text,
  phone_e164          text,
  email               citext,
  payment_terms_days  int check (payment_terms_days between 0 and 365),
  default_account_id  uuid,
  default_category    text,
  is_foreign          boolean not null default false,
  reminder_consent_at timestamptz,
  created_at          timestamptz not null default now(),
  unique (id, org_id),
  foreign key (default_account_id, org_id) references accounts (id, org_id)
);
create index contacts_org_name_idx on contacts (org_id, name_normalised);
create index contacts_org_vat_idx on contacts (org_id, vat_number) where vat_number is not null;

create table vat_periods (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organisations (id),
  starts_on        date not null,
  ends_on          date not null,
  frequency        text not null check (frequency in ('monthly', 'quarterly')),
  status           text not null default 'open' check (status in ('open', 'in_review', 'signed_off', 'filed', 'paid', 'closed')),
  due_on           date not null,
  extended_due_on  date not null,
  reopened_reason  text,
  created_at       timestamptz not null default now(),
  unique (org_id, starts_on),
  unique (id, org_id),
  check (ends_on >= starts_on),
  exclude using gist (org_id with =, daterange(starts_on, ends_on, '[]') with &&)
);

-- A period only moves forward, except an admin reopen (signed_off -> in_review) which needs a reason.
create or replace function app.guard_period_status() returns trigger
language plpgsql as $$
declare
  rank_old int := array_position(array['open','in_review','signed_off','filed','paid','closed'], old.status);
  rank_new int := array_position(array['open','in_review','signed_off','filed','paid','closed'], new.status);
begin
  if rank_new < rank_old then
    if not (old.status = 'signed_off' and new.status = 'in_review' and new.reopened_reason is not null
            and new.reopened_reason is distinct from old.reopened_reason) then
      raise exception 'period_status_cannot_go_back: % -> %', old.status, new.status using errcode = 'P0001';
    end if;
  end if;
  if (new.starts_on, new.ends_on, new.org_id) is distinct from (old.starts_on, old.ends_on, old.org_id) then
    raise exception 'period_dates_immutable' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger vat_periods_status_guard before update on vat_periods for each row execute function app.guard_period_status();

create table documents (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organisations (id),
  kind                text not null default 'purchase_invoice' check (kind in ('purchase_invoice', 'sales_invoice', 'till_report', 'bank_statement', 'mra_letter', 'mra_acknowledgement', 'payment_proof', 'other')),
  source              text not null check (source in ('camera', 'gallery', 'pdf', 'whatsapp', 'web', 'system')),
  storage_key         text not null unique,
  mime_type           text not null,
  byte_size           int,
  original_filename   text,
  sha256              text,
  dhash               bit(64),           -- perceptual hash; near-duplicates via bit_count(a # b)
  status              text not null default 'uploading' check (status in ('uploading', 'processing', 'rejected_quality', 'duplicate', 'awaiting_owner', 'needs_review', 'posted', 'archived', 'failed')),
  quality             jsonb,
  extraction          jsonb,
  extraction_provider text,
  confidence          numeric(4, 3),
  flags               text[] not null default '{}',
  duplicate_of        uuid references documents (id),
  uploaded_by         uuid references users (id),
  created_at          timestamptz not null default now(),
  processed_at        timestamptz,
  retain_until        date not null default (current_date + interval '6 years')::date,
  unique (id, org_id)
);
-- The same file can only live once per organisation; a re-upload is recorded as status 'duplicate'.
create unique index documents_org_sha256_uq on documents (org_id, sha256) where sha256 is not null and status <> 'duplicate';
create index documents_org_status_idx on documents (org_id, status);

create or replace function app.guard_document_delete() returns trigger
language plpgsql as $$
begin
  if old.retain_until > current_date then
    raise exception 'document % must be kept until % (VAT Act: at least 5 years)', old.id, old.retain_until using errcode = 'P0001';
  end if;
  return old;
end $$;
create trigger documents_retention before delete on documents for each row execute function app.guard_document_delete();

create table transactions (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organisations (id),
  kind                text not null check (kind in ('purchase_invoice', 'purchase_credit_note', 'sales_invoice', 'sales_credit_note', 'daily_takings', 'payment', 'receipt', 'deposit', 'opening_balance', 'journal')),
  status              text not null default 'draft' check (status in ('draft', 'awaiting_owner', 'needs_review', 'posted', 'void')),
  contact_id          uuid,
  document_id         uuid,
  reference           text,
  issue_date          date not null,
  delivery_date       date,
  due_date            date,
  settlement          text check (settlement in ('cash', 'credit')),
  payment_method      text check (payment_method in ('cash', 'bank', 'juice', 'card', 'stripe')),
  category            text,
  open_item_side      text check (open_item_side in ('receivable', 'payable')),
  currency            char(3) not null default 'MUR',
  fx_rate             numeric(18, 8),
  fx_source           text,
  net_cents           bigint not null default 0,
  vat_cents           bigint not null default 0,
  gross_cents         bigint not null default 0,
  is_late             boolean not null default false,
  late_reason         text,
  original_period_id  uuid,
  period_id           uuid,
  posted_entry_id     uuid,
  void_reason         text,
  created_by          uuid references users (id),
  created_at          timestamptz not null default now(),
  posted_at           timestamptz,
  unique (id, org_id),
  check (gross_cents = net_cents + vat_cents),
  check (not is_late or late_reason is not null),
  check (status <> 'void' or void_reason is not null),
  foreign key (contact_id, org_id) references contacts (id, org_id),
  foreign key (document_id, org_id) references documents (id, org_id),
  foreign key (period_id, org_id) references vat_periods (id, org_id),
  foreign key (original_period_id, org_id) references vat_periods (id, org_id)
);
create index transactions_org_kind_idx on transactions (org_id, kind, status);
create index transactions_open_items_idx on transactions (org_id, contact_id) where settlement = 'credit' and status = 'posted';
-- Business-key duplicate guard: one live supplier invoice number per supplier.
create unique index transactions_supplier_ref_uq on transactions (org_id, contact_id, kind, upper(reference))
  where status <> 'void' and reference is not null and kind in ('purchase_invoice', 'purchase_credit_note');

create table lines (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null,
  transaction_id  uuid not null,
  line_no         int not null,
  description     text,
  quantity        numeric(14, 3),
  account_id      uuid,
  vat_code        text not null references vat_codes (code),
  payment_method  text check (payment_method in ('cash', 'card', 'juice', 'credit')),
  net_cents       bigint not null,
  vat_cents       bigint not null,
  gross_cents     bigint generated always as (net_cents + vat_cents) stored,
  unique (transaction_id, line_no),
  foreign key (transaction_id, org_id) references transactions (id, org_id) on delete cascade,
  foreign key (account_id, org_id) references accounts (id, org_id)
);

create table journal_entries (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organisations (id),
  entry_no        bigint not null,
  entry_date      date not null,
  period_id       uuid not null,
  source_type     text not null check (source_type in ('transaction', 'reversal', 'opening', 'adjustment', 'vat_settlement')),
  transaction_id  uuid,
  description     text not null,
  reversal_of     uuid references journal_entries (id),
  reason          text,
  posted_by       uuid references users (id),
  posted_at       timestamptz not null default now(),
  unique (org_id, entry_no),
  unique (id, org_id),
  check (reversal_of is null or reason is not null),
  foreign key (period_id, org_id) references vat_periods (id, org_id),
  foreign key (transaction_id, org_id) references transactions (id, org_id)
);
-- An entry can be reversed once.
create unique index journal_entries_single_reversal on journal_entries (reversal_of) where reversal_of is not null;
create index journal_entries_period_idx on journal_entries (org_id, period_id);

alter table transactions add constraint transactions_posted_entry_fk
  foreign key (posted_entry_id, org_id) references journal_entries (id, org_id);

create table journal_lines (
  id            bigint generated always as identity primary key,
  org_id        uuid not null,
  entry_id      uuid not null,
  line_no       int not null,
  account_id    uuid not null,
  debit_cents   bigint not null default 0 check (debit_cents >= 0),
  credit_cents  bigint not null default 0 check (credit_cents >= 0),
  vat_code      text references vat_codes (code),
  vat_role      text check (vat_role in ('base', 'tax')),
  contact_id    uuid,
  memo          text,
  unique (entry_id, line_no),
  check ((debit_cents = 0) <> (credit_cents = 0)),
  check (vat_role is null or vat_code is not null),
  foreign key (entry_id, org_id) references journal_entries (id, org_id),
  foreign key (account_id, org_id) references accounts (id, org_id),
  foreign key (contact_id, org_id) references contacts (id, org_id)
);
create index journal_lines_entry_idx on journal_lines (entry_id);

create table allocations (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null,
  payment_transaction_id  uuid not null,
  invoice_transaction_id  uuid not null,
  amount_cents            bigint not null check (amount_cents <> 0),
  allocated_on            date not null,
  created_at              timestamptz not null default now(),
  foreign key (payment_transaction_id, org_id) references transactions (id, org_id),
  foreign key (invoice_transaction_id, org_id) references transactions (id, org_id)
);
create index allocations_invoice_idx on allocations (invoice_transaction_id);

-- Ledger rules enforced by the database, whatever the application does.
create trigger journal_entries_immutable before update or delete on journal_entries for each row execute function app.forbid_mutation();
create trigger journal_lines_immutable before update or delete on journal_lines for each row execute function app.forbid_mutation();
create trigger allocations_immutable before update or delete on allocations for each row execute function app.forbid_mutation();

create or replace function app.check_entry_balanced() returns trigger
language plpgsql as $$
declare
  v_entry uuid;
  d bigint;
  c bigint;
  n int;
begin
  if tg_table_name = 'journal_lines' then v_entry := new.entry_id; else v_entry := new.id; end if;
  select coalesce(sum(debit_cents), 0), coalesce(sum(credit_cents), 0), count(*)
    into d, c, n from journal_lines where entry_id = v_entry;
  if n < 2 then
    raise exception 'journal entry % has % line(s); at least 2 required', v_entry, n using errcode = '23514';
  end if;
  if d <> c then
    raise exception 'journal entry % is unbalanced: debits % credits %', v_entry, d, c using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger journal_lines_balanced after insert on journal_lines
  deferrable initially deferred for each row execute function app.check_entry_balanced();
create constraint trigger journal_entries_have_lines after insert on journal_entries
  deferrable initially deferred for each row execute function app.check_entry_balanced();

create or replace function app.check_period_open() returns trigger
language plpgsql as $$
declare p record;
begin
  -- FOR SHARE: a concurrent sign-off (which takes FOR UPDATE) waits for this posting to commit, and vice versa.
  select status, starts_on, ends_on into p from vat_periods where id = new.period_id and org_id = new.org_id for share;
  if not found then raise exception 'period % not found', new.period_id using errcode = 'P0001'; end if;
  if p.status not in ('open', 'in_review') then
    raise exception 'period_locked: period % is %', new.period_id, p.status using errcode = 'P0001';
  end if;
  if new.entry_date < p.starts_on or new.entry_date > p.ends_on then
    raise exception 'entry date % is outside its period (% to %)', new.entry_date, p.starts_on, p.ends_on using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger journal_entries_period_open before insert on journal_entries for each row execute function app.check_period_open();

-- Posted transactions are frozen: correct by voiding (reversal) and recording a new one.
create or replace function app.guard_transaction() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('posted', 'void') then
      raise exception 'transaction % is % and cannot be deleted', old.id, old.status using errcode = 'P0001';
    end if;
    return old;
  end if;
  if old.status = 'void' then
    raise exception 'void transaction % cannot change', old.id using errcode = 'P0001';
  end if;
  if old.status = 'posted' then
    if new.status not in ('posted', 'void') then
      raise exception 'posted transaction % can only be voided', old.id using errcode = 'P0001';
    end if;
    if (new.kind, new.contact_id, new.reference, new.issue_date, new.due_date, new.net_cents, new.vat_cents,
        new.gross_cents, new.period_id, new.posted_entry_id, new.settlement, new.payment_method, new.is_late)
       is distinct from
       (old.kind, old.contact_id, old.reference, old.issue_date, old.due_date, old.net_cents, old.vat_cents,
        old.gross_cents, old.period_id, old.posted_entry_id, old.settlement, old.payment_method, old.is_late) then
      raise exception 'posted transaction % is immutable; void it and record a new one', old.id using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
create trigger transactions_guard before update or delete on transactions for each row execute function app.guard_transaction();

create or replace function app.guard_lines() returns trigger
language plpgsql as $$
declare v_status text;
begin
  select status into v_status from transactions where id = coalesce(new.transaction_id, old.transaction_id);
  if v_status in ('posted', 'void') then
    raise exception 'lines of a % transaction cannot change', v_status using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end $$;
create trigger lines_guard before insert or update or delete on lines for each row execute function app.guard_lines();
