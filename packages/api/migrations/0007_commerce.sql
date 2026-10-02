-- Subscriptions, bookings, online payments (Stripe), webhook idempotency, outbound messages.
create table subscriptions (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references organisations (id),
  plan                  text not null check (plan in ('starter', 'assisted', 'full_service')),
  status                text not null check (status in ('trialing', 'active', 'past_due', 'cancelled', 'lapsed')),
  billing_cycle         text not null default 'monthly' check (billing_cycle in ('monthly', 'annual')),
  price_cents           bigint not null check (price_cents >= 0),
  current_period_start  date,
  current_period_end    date,
  provider              text,
  provider_ref          text,
  created_at            timestamptz not null default now(),
  cancelled_at          timestamptz
);
create unique index subscriptions_one_live on subscriptions (org_id) where status in ('trialing', 'active', 'past_due');

create table bookings (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references organisations (id),
  platform_org_id     uuid not null references organisations (id),
  kind                text not null default 'onboarding_call' check (kind in ('onboarding_call', 'review_call')),
  starts_at           timestamptz not null,
  status              text not null default 'pending_deposit' check (status in ('pending_deposit', 'confirmed', 'completed', 'cancelled', 'no_show')),
  deposit_payment_id  uuid,
  created_by          uuid references users (id),
  created_at          timestamptz not null default now()
);

create table payments (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references organisations (id),
  payer_org_id             uuid references organisations (id),
  payable_kind             text not null check (payable_kind in ('invoice', 'booking')),
  payable_id               uuid not null,
  payer_name               text,
  amount_cents             bigint not null check (amount_cents > 0),
  currency                 char(3) not null default 'MUR',
  provider                 text not null,
  provider_session_id      text unique,
  provider_payment_intent  text,
  checkout_url             text,
  status                   text not null default 'pending' check (status in ('pending', 'succeeded', 'failed', 'expired', 'refunded')),
  transaction_id           uuid,
  created_by               uuid references users (id),
  created_at               timestamptz not null default now(),
  completed_at             timestamptz,
  foreign key (transaction_id, org_id) references transactions (id, org_id)
);
alter table bookings add constraint bookings_deposit_fk foreign key (deposit_payment_id) references payments (id);

create table webhook_events (
  provider      text not null,
  event_id      text not null,
  type          text not null,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  error         text,
  primary key (provider, event_id)
);

create table outbound_messages (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references organisations (id),
  idempotency_key  text not null unique,
  channel          text not null check (channel in ('sms', 'whatsapp')),
  to_e164          text not null,
  template_key     text not null,
  locale           text not null check (locale in ('en', 'fr', 'mfe')),
  variables        jsonb not null,
  body_preview     text not null,
  status           text not null default 'queued' check (status in ('queued', 'sent', 'delivered', 'failed', 'skipped')),
  provider_sid     text unique,
  error            text,
  scheduled_for    timestamptz not null,
  sent_at          timestamptz,
  created_at       timestamptz not null default now()
);
create index outbound_messages_due_idx on outbound_messages (scheduled_for) where status = 'queued';
