# PR: Send staff invites from Nex-Gen's own mailbox (SMTP, cPanel)

## Why

Nex-Gen's mail (`connect@nex-gen.africa`) is hosted on cPanel, not Microsoft 365. The simplest production setup is to send invites from a dedicated mailbox on the same host: no new vendor, no new cost.

## Changes

- **`smtp` provider** behind the existing mail interface, using nodemailer 10 (licence MIT-0):
  - sign-in with the mailbox's full address and password;
  - always TLS: 465 TLS from the start, 587 STARTTLS, minimum TLS 1.2;
  - plaintext only for a local test server outside production.
  - Failures are classed: 4xx and network trouble are retryable. A rejected sign-in, a certificate mismatch or a 5xx are not, and each comes with the fix (full address as user; the server name from cPanel's Connect Devices).
- **Settings:** `SMTP_HOST`, `SMTP_PORT`, `SMTP_TLS`, `SMTP_USER`, `SMTP_PASS`. The API warns at startup if `MAIL_FROM` differs from the signed-in mailbox, and production refuses plaintext SMTP or a placeholder sender.
- **Admin → Staff → "Send a test email to me"** (`POST /admin/mail/test`) proves the setup before anyone is invited. Test emails are logged like invites (migration 0014).
- **Repository install:** `.npmrc` sets `legacy-peer-deps=true` and Vite is declared explicitly. A plain install had pruned packages the test tools need.

## Tests

- **Unit:** real SMTP sessions against an in-process mail server, covering sign-in, both message parts, reply-to and the kind header; a wrong password; a temporary refusal (451, retryable); an unknown recipient (550, permanent); an unreachable server; and the TLS rules.
- **End to end:** `npm run test:e2e:smtp`, with the API configured as for the cPanel mailbox. The test email arrives; admin invites → the email is delivered over SMTP → the invitee accepts through the delivered link → memberships exist.
- **Web:** the test-email button.

## Before production

Follow "Nex-Gen's cPanel mailbox (SMTP)" in `DEVELOPMENT.md`: create `invites@nex-gen.africa`, check SPF and DKIM, add DMARC, set the `SMTP_*` settings, and send a test email from the console.
