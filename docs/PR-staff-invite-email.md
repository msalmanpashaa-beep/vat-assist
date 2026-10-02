# PR: Send staff invites by email (Postmark, Resend or Microsoft 365)

## Summary

Admins now send staff invites straight from the console. The one-time link goes by email through the configured provider, and the console no longer shows it, except when sending fails.

## Changes

- **Mail module** (`packages/api/src/modules/mail`): one `MailProvider` interface with four implementations.
  - `postmark`: `POST /email` with the server token.
  - `resend`: `POST /emails` with a bearer key and `Idempotency-Key`.
  - `m365`: Microsoft Graph `sendMail` with an app-only token, cached and refreshed once on 401.
  - `console`: development.
  - Errors are classed as retryable (network, 408, 429, 5xx) or permanent.
- **Config:** `MAIL_PROVIDER`, `MAIL_FROM`, `MAIL_REPLY_TO`, and the per-provider settings. Startup checks fail fast and name what is missing; production refuses `console` and placeholder senders.
- **Invite workflow:** renders a plain-text and HTML invite (escaped, Mauritius-time expiry) and sends it.
  - Every attempt is logged in `email_messages` (migration 0013, platform admins only), never with the body.
  - The response says whether the email went out; the link is returned only if it did not.
- **Admin console:** "Send invite" and "Resend invite", with the delivery outcome shown, and the latest invite-email status per person in the staff list.
- **Development:** `GET /dev/mail/outbox`. Addresses on `.invalid` fail on purpose.

## Tests

- **Unit** (`packages/api/test/mail.test.ts`, 18 tests): request shapes for all three providers, error classing, Graph token reuse and refresh, missing-settings checks, production guards, template escaping, and a real HTTP round trip to a stand-in Postmark server.
- **End to end** (`packages/api/test/e2e/staff-invite-email.e2e.ts`): admin creates the invite → email sent → invitee accepts through the emailed link (password, then authenticator) → the Nex-Gen membership and the linked client membership exist. It also covers the not-sent fallback.
- **Web:** the console shows the emailed or failed outcome and the per-person status.

## To finish before production

Choose the provider and follow its setup in `DEVELOPMENT.md`. For Microsoft 365, scope the app to the sender mailbox with Exchange RBAC for Applications, not a tenant-wide `Mail.Send` grant.
