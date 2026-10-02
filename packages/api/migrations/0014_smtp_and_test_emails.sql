-- SMTP (a hosted mailbox, e.g. on cPanel) as a mail provider, and admin test emails in the log.
alter table email_messages drop constraint email_messages_provider_check;
alter table email_messages add constraint email_messages_provider_check
  check (provider in ('console', 'postmark', 'resend', 'm365', 'smtp'));
alter table email_messages drop constraint email_messages_kind_check;
alter table email_messages add constraint email_messages_kind_check check (kind in ('staff_invite', 'test'));
