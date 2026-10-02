-- Reference data shared by every organisation: VAT codes, effective-dated VAT rules, public holidays,
-- and MRA's published list of VAT-registered persons.
create table vat_codes (
  code              text primary key,
  description       text not null,
  input_claimable   boolean not null,
  mra_supply_type   text
);

create table vat_rules (
  id          serial primary key,
  key         text not null,
  value       jsonb not null,
  valid_from  date not null,
  valid_to    date,
  source_url  text,
  note        text,
  verified_by_reviewer boolean not null default false,
  exclude using gist (key with =, daterange(valid_from, coalesce(valid_to, 'infinity'::date), '[]') with &&)
);

create or replace function app.rule(p_key text, p_on date) returns jsonb
language sql stable as $$
  select value from vat_rules
  where key = p_key and valid_from <= p_on and (valid_to is null or valid_to >= p_on)
$$;

create table public_holidays (
  holiday_date  date primary key,
  name          text not null,
  verified      boolean not null default false,
  source        text
);

create table mra_registered_persons (
  vat_number   text primary key check (vat_number ~ '^[0-9]{8}$'),
  name         text not null,
  brn          text,
  list_date    date not null,
  imported_at  timestamptz not null default now()
);
create index mra_registered_persons_name_idx on mra_registered_persons (app.normalise_name(name));
