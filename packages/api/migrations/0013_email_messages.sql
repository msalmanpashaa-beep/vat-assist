-- Outbound email log for staff invites. Bodies are never stored: an invite carries a one-time sign-in link.
create table email_messages (
  id                   uuid primary key default gen_random_uuid(),
  kind                 text not null check (kind in ('staff_invite')),
  to_email             citext not null,
  subject              text not null,
  provider             text not null check (provider in ('console', 'postmark', 'resend', 'm365')),
  provider_message_id  text,
  status               text not null check (status in ('sent', 'failed')),
  error                text,
  related_user_id      uuid references users (id),
  created_by           uuid references users (id),
  created_at           timestamptz not null default now()
);
create index email_messages_user on email_messages (related_user_id, created_at desc);

alter table email_messages enable row level security;
create policy platform_admins on email_messages for all to vat_app
  using (app.is_platform_admin()) with check (app.is_platform_admin());
grant select, insert on email_messages to vat_app;
