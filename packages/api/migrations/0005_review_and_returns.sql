-- Reviewer queries and VAT returns (versioned drafts, one signed version per period).
create table queries (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organisations (id),
  period_id       uuid,
  transaction_id  uuid,
  document_id     uuid,
  status          text not null default 'open' check (status in ('open', 'answered', 'resolved', 'cancelled')),
  blocking        boolean not null default true,
  raised_by       uuid references users (id),          -- null = raised automatically by the system
  raised_at       timestamptz not null default now(),
  resolved_by     uuid references users (id),
  resolved_at     timestamptz,
  respond_by      timestamptz,
  unique (id, org_id),
  foreign key (period_id, org_id) references vat_periods (id, org_id),
  foreign key (transaction_id, org_id) references transactions (id, org_id),
  foreign key (document_id, org_id) references documents (id, org_id)
);
create index queries_org_status_idx on queries (org_id, status);

create table query_messages (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null,
  query_id                uuid not null,
  author_id               uuid references users (id),     -- null = system message
  body                    text,
  attachment_document_id  uuid,
  created_at              timestamptz not null default now(),
  foreign key (query_id, org_id) references queries (id, org_id),
  foreign key (attachment_document_id, org_id) references documents (id, org_id)
);
create trigger query_messages_immutable before update or delete on query_messages for each row execute function app.forbid_mutation();

create table vat_returns (
  id                           uuid primary key default gen_random_uuid(),
  org_id                       uuid not null,
  period_id                    uuid not null,
  version                      int not null,
  status                       text not null default 'draft' check (status in ('draft', 'superseded', 'signed_off', 'filed', 'paid')),
  figures                      jsonb not null,
  supporting                   jsonb not null,
  fingerprint                  text not null,
  prepared_by                  uuid references users (id),
  prepared_at                  timestamptz not null default now(),
  signed_off_by                uuid references users (id),
  signed_off_at                timestamptz,
  mra_reference                text,
  acknowledgement_document_id  uuid,
  filed_at                     timestamptz,
  payment_reference            text,
  payment_document_id          uuid,
  paid_on                      date,
  unique (period_id, version),
  unique (id, org_id),
  foreign key (period_id, org_id) references vat_periods (id, org_id),
  foreign key (acknowledgement_document_id, org_id) references documents (id, org_id),
  foreign key (payment_document_id, org_id) references documents (id, org_id)
);
create unique index vat_returns_one_signed on vat_returns (period_id) where status in ('signed_off', 'filed', 'paid');

-- Once signed off, figures and fingerprint are frozen; status only moves signed_off -> filed -> paid.
create or replace function app.guard_vat_return() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'vat returns are never deleted' using errcode = 'P0001'; end if;
  if old.status in ('signed_off', 'filed', 'paid') then
    if (new.figures, new.supporting, new.fingerprint, new.version, new.period_id, new.signed_off_by, new.signed_off_at)
       is distinct from (old.figures, old.supporting, old.fingerprint, old.version, old.period_id, old.signed_off_by, old.signed_off_at) then
      raise exception 'signed vat return % is frozen', old.id using errcode = 'P0001';
    end if;
    if not ((old.status = new.status) or (old.status = 'signed_off' and new.status = 'filed') or (old.status = 'filed' and new.status = 'paid')) then
      raise exception 'vat return status cannot move % -> %', old.status, new.status using errcode = 'P0001';
    end if;
  elsif old.status = 'superseded' then
    raise exception 'superseded vat return % is frozen', old.id using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger vat_returns_guard before update or delete on vat_returns for each row execute function app.guard_vat_return();
