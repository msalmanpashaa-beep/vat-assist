# Development guide

How to run VAT Assist locally, try the owner and admin screens, switch features per business, and run every test. First-time setup (Docker, `.env`, install) is in `README.md`.

## Start everything

```
npm run infra:up            # Postgres, Redis, MinIO
npm run build               # shared package first, then API and web
npm run db:migrate          # migrations 0001–0012
npm run db:seed             # Nex-Gen org + admin, reviewer, senior reviewer logins
npm run dev:api             # API on http://localhost:4000
npm run demo:data           # a ready business ("Boutik Screens") with customers and a supplier bill
npm run dev:web             # web on http://localhost:3000
EXPO_PUBLIC_API_URL=http://<your-LAN-IP>:4000 npm run dev:mobile   # phone app (Expo Go or a simulator)
```

In development, SMS codes are always `000000`, and messages print in the API log instead of being sent.

Staff authenticator codes come from the secrets in `packages/api/demo-output/staff-credentials.json`:

```
node -e "require('otplib').generate({ secret: 'PASTE_SECRET' }).then(console.log)"
```

## Where the new screens are

| Screen | Web | Phone app |
|---|---|---|
| Opening balances (onboarding) | `/owner/<orgId>/opening-balances` | right after "Your business" in onboarding; also Home → Opening balances |
| Credit sales invoice | `/owner/<orgId>/invoices/new` | Home or Money → New invoice on credit |
| Customer payment | `/owner/<orgId>/payments/receive` | Home → Customer paid you |
| Supplier payment | `/owner/<orgId>/payments/pay` | Home → You paid a supplier |
| Reminder and WhatsApp settings | `/owner/<orgId>/settings` | Home → Settings (WhatsApp opens the consent screen) |
| Clients and reviewer assignment, bulk reassign | `/admin/clients` | – |
| Staff: invite, reset 2FA, temporary code, disable | `/admin/staff` | – |
| Feature flags per business | `/admin/features` | – |
| Accept a staff invite | `/invite/<token>` | – |

- Owners sign in at `/owner/login` (web) or on the phone with the number `demo:data` printed.
- Staff sign in at `/login`. The admin console is only reachable for Nex-Gen admins; the API checks this on every call.

## Feature flags

Five screens can be switched per business:

| Flag | Controls |
|---|---|
| `opening_balances` | Opening balances screen and its API |
| `credit_invoices` | Sales invoices on credit |
| `record_payments` | Customer and supplier payments recorded by the owner |
| `invoice_reminders` | The reminder switch, and reminder sending |
| `whatsapp_opt_in` | The WhatsApp switch and consent screen |

How they behave:

- With no override, a flag is on. Defaults live in `packages/shared/src/features.ts`.
- To toggle one, use **Admin → Feature flags**, or the API:

```
PUT /admin/orgs/<orgId>/features
{ "features": { "credit_invoices": false } }
```

- A flag that is off hides the screen on web and phone.
- The API refuses the matching calls with `403 feature_disabled`, so an old app version cannot bypass it.
- Nex-Gen reviewers can still record entries for a client when the owner's screen is off.

## Reminders and WhatsApp

- **Switching invoice reminders on:**
  - It sets `debtor_reminders_enabled`.
  - It immediately schedules reminders for open invoices due tomorrow whose customer has a mobile number and agreed to reminders.
  - Invoices created later are scheduled by the `reminders.invoice_created` background job.
- **Switching off** cancels everything still queued for that shop (`status = cancelled`).
- **Background jobs:** with `REDIS_URL` set, jobs and the 15-minute reminder tick run on BullMQ; without it they run inline. To simulate a send time, call `POST /admin/reminders/run {"now": "<ISO time>"}` as an admin.
- **WhatsApp:**
  - Opting in records the consent wording version (`WHATSAPP_CONSENT` in `packages/shared/src/consent.ts`).
  - Consent is checked again at send time. Someone who opted out after a message was queued gets SMS instead.
  - Real WhatsApp sending also needs `TWILIO_WHATSAPP_CONTENT_SIDS` (Meta-approved templates).

## Staff accounts

- **Invite:**
  - **Admin → Staff → Invite** takes an email, a role, and optionally the clients to link straight away.
  - It emails a one-time link, valid for 7 days, through the configured provider (see **Email for staff invites** below).
  - The console shows the link only if the email could not be sent, so the admin can pass it on another way.
  - The person then sets a password and an authenticator.
- **Reset 2FA:** removes the authenticator and ends all sessions; the person enrols again at next sign-in.
- **Temporary recovery code:** works once, within 24 hours, for someone whose authenticator is set up but unavailable. Issuing a new code retires the previous one.

## Email for staff invites

Invites are sent through one mail interface (`packages/api/src/modules/mail`). `MAIL_PROVIDER` chooses the service:

| `MAIL_PROVIDER` | Sends through | Use when |
|---|---|---|
| `console` (default) | Nothing: printed in the API log | Development and tests |
| `smtp` | Your own mailbox over SMTP, for example on cPanel hosting | **Nex-Gen today:** `connect@nex-gen.africa` on the existing cPanel host. No new vendor or cost |
| `m365` | Microsoft Graph, from a Nex-Gen mailbox | Nex-Gen's mail is on Microsoft 365. No new vendor, and invites appear in the mailbox's Sent Items |
| `postmark` | Postmark | You want a dedicated transactional email service |
| `resend` | Resend | You want the quickest setup |

How it behaves:

- **Sent:** the admin console says the invite was emailed and does not show the link.
- **Not sent:** the console shows the reason and the link, so the admin can pass it on another way.
- **Logged:** every attempt is recorded in `email_messages` (never the body, which carries the link) and shown in the staff list.
- **Production:** the API refuses to start with the console provider, with a placeholder sender, or without the chosen provider's settings. The error names what is missing.

### Development

- Emails print in the API log.
- The last 50 are kept at `GET /dev/mail/outbox?to=<email>`. This is development only and returns 404 in production or with a real provider.
- Addresses on the reserved `.invalid` domain (e.g. `someone@fail.invalid`) fail on purpose, so you can try the not-sent path.

### Nex-Gen's cPanel mailbox (SMTP), in use now

**For now, invites go out from `connect@nex-gen.africa` itself**, so replies land straight back in that inbox. Later, a dedicated mailbox such as `invites@nex-gen.africa` would keep the main mailbox's password off servers. Only `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM` would change.

cPanel's Connect Devices settings for the mailbox:
- **Outgoing server:** `mail.nex-gen.africa`
- **SMTP port:** 465, secure SSL/TLS
- **Sign-in:** required; the username is the full address.

1. **Check that mail from the domain is trusted.**
   - cPanel → **Email Deliverability**: SPF and DKIM for `nex-gen.africa` should show as valid.
   - Add a DMARC record (TXT on `_dmarc.nex-gen.africa`): `v=DMARC1; p=none; rua=mailto:connect@nex-gen.africa`. Tighten it once the reports look clean.
2. **Settings for the API** (also in `.env.production.example`):

```
MAIL_PROVIDER=smtp
SMTP_HOST=mail.nex-gen.africa
SMTP_PORT=465
SMTP_TLS=implicit
SMTP_USER=connect@nex-gen.africa
SMTP_PASS=<the mailbox password, set only in the host's secret settings>
MAIL_FROM="Nex-Gen Africa <connect@nex-gen.africa>"
```

   `MAIL_FROM` must be the mailbox you sign in with; the host rejects anything else, and the API warns at startup.
3. **Check it works.** Admin → Staff → **Send a test email to me**, then look in the inbox and the spam folder.

**Limits:** hosting plans cap how many emails a mailbox may send per hour, so ask the host. Staff invites are a handful a month. If VAT Assist later emails customers in volume, move to Postmark or Resend on the same domain.

**Plaintext SMTP** (`SMTP_TLS=none`) is only accepted for a test server on `127.0.0.1` or `localhost`, outside production.

### Microsoft 365 (Graph)

1. **Sender mailbox:** create one, for example a shared mailbox `invites@yourdomain`.
2. **Entra app:** Entra ID → App registrations → New registration ("VAT Assist mail").
   - Note the Application (client) ID and the Directory (tenant) ID.
   - Certificates & secrets → New client secret. Note the value and its expiry date, and rotate it before then.
3. **Mailbox permission:** do not grant Microsoft Graph's `Mail.Send` application permission in Entra. Granted there, it lets the app send as any mailbox in the tenant, and it overrides mailbox scoping. Scope the app to the one mailbox in Exchange instead, with RBAC for Applications (Microsoft's replacement for application access policies):

```powershell
Connect-ExchangeOnline
# ObjectId is the Enterprise application's object ID (Entra → Enterprise applications), not the app registration's.
New-ServicePrincipal -AppId <client-id> -ObjectId <enterprise-app-object-id> -DisplayName "VAT Assist mail"
New-ManagementScope -Name "VAT Assist sender" -RecipientRestrictionFilter "PrimarySmtpAddress -eq 'invites@yourdomain'"
New-ManagementRoleAssignment -App <client-id> -Role "Application Mail.Send" -CustomResourceScope "VAT Assist sender"
Test-ServicePrincipalAuthorization -Identity <client-id> -Resource invites@yourdomain
```

   Allow some time for the assignment to take effect.
4. **Settings:**

```
MAIL_PROVIDER=m365
M365_TENANT_ID=<directory-tenant-id>
M365_CLIENT_ID=<application-client-id>
M365_CLIENT_SECRET=<client-secret-value>
M365_SENDER=invites@yourdomain
```

   `MAIL_FROM` is not used here, because Graph sends as the mailbox.
5. **Check:** invite yourself from Admin → Staff. The message appears in the mailbox's Sent Items. A `403` in the staff list means the Exchange role assignment is missing or not active yet.

### Postmark

1. Create a Server and use its default transactional stream, `outbound`.
2. Verify the sender: add your domain's DNS records under Sender Signatures, or confirm the single address used in `MAIL_FROM`.
3. On the server's API Tokens tab, copy the Server API token.
4. Settings:

```
MAIL_PROVIDER=postmark
POSTMARK_SERVER_TOKEN=<server-api-token>
MAIL_FROM=Nex-Gen Africa <invites@yourdomain>
POSTMARK_MESSAGE_STREAM=outbound
```

5. **Dry run:** `POSTMARK_SERVER_TOKEN=POSTMARK_API_TEST` makes Postmark accept the request without delivering anything.
6. **New accounts:** a new Postmark account may be restricted until Postmark approves it, so send your first test invites to your own domain.

### Resend

1. Domains → add your domain, add the DNS records it shows, and verify it.
2. API Keys → create a key with sending access.
3. Settings:

```
MAIL_PROVIDER=resend
RESEND_API_KEY=re_...
MAIL_FROM=Nex-Gen Africa <invites@yourdomain>
```

4. **Before the domain is verified,** Resend's test addresses work: send from `onboarding@resend.dev` to `delivered@resend.dev`.
5. **Duplicates:** each invite carries an `Idempotency-Key`, so a retried request does not email twice. Resend keeps keys for 24 hours.

## Deployment, pilot and demos

- **Deploying:** `docs/DEPLOYMENT.md`.
  - The web app runs on Vercel; the API runs as a container.
  - GitHub Actions deploys after CI passes: migrations, then the API image, then the web app.
  - Check production settings with `npm run config:check -- ../../.env.production`. Add `--template` to check `.env.production.example`.
  - First admin in a new environment: `npm run bootstrap -- --platform-name "..." --admin-email ... --admin-name "..."`.
- **Pilot:** `docs/PILOT.md` has the checklist, the targets and the weekly routine. **Admin → Pilot** shows the live scorecard.
  - Shops get a referral code at sign-up; a new shop can quote one.
- **Demos:**
  - `npm run demo:pitch` is the presentation order with narration and checks.
  - `docs/DEMO-SCRIPT.md` is the talk track.
  - `npm run demo` is the full 18-step story.
- **Development outboxes:** SMS and WhatsApp messages sent by the console provider are at `GET /dev/messages/outbox?to=<+230...>`; emails are at `GET /dev/mail/outbox`.

## Tests

```
npm test                      # unit and screen tests: shared, api, web (Vitest + Testing Library), mobile (Jest + jest-expo)
npm run typecheck             # every package
npm run test:e2e              # end to end against a running API with the seed loaded (npm run dev:api first)
npm run test:e2e:smtp         # the invite flow over real SMTP (see below)
npm run demo                  # the original 18-step self-checking story
```

The end-to-end suite (`packages/api/test/e2e/owner-admin.e2e.ts`) creates its own business on every run. It covers:

- onboarding opening balances, snapping an invoice, a credit invoice, a customer payment and a supplier payment;
- ageing and journal updates;
- the reviewer query flow;
- the reminder and WhatsApp toggles;
- invites, assignments, 2FA reset with a temporary code, disabling staff, and feature flags.

`packages/api/test/e2e/staff-invite-email.e2e.ts` covers the invite email: admin creates the invite, the email is sent, the invitee follows the emailed link and sets a password and an authenticator, and their memberships exist. It also covers the not-sent fallback. Provider unit tests (`packages/api/test/mail.test.ts`) check Postmark, Resend and Graph requests, errors, token reuse and retries, including a real HTTP round trip to a stand-in server.

**The invite flow over real SMTP.** The suite starts a test mail server that checks the sign-in and keeps what it receives. The API is pointed at it exactly as it would be at the cPanel host:

```
# terminal 1
MAIL_PROVIDER=smtp SMTP_HOST=127.0.0.1 SMTP_PORT=2525 SMTP_TLS=none SMTP_USER=connect@nex-gen.africa SMTP_PASS=e2e-smtp-pass \
  MAIL_FROM="Nex-Gen Africa <connect@nex-gen.africa>" npm run dev:api
# terminal 2
E2E_SMTP_SINK_PORT=2525 E2E_SMTP_USER=connect@nex-gen.africa E2E_SMTP_PASS=e2e-smtp-pass npm run test:e2e:smtp
```

The suite checks:
- the admin test email arrives through the mailbox sign-in;
- the invite is delivered;
- the invitee follows the link from the delivered email, sets a password and an authenticator;
- the Nex-Gen membership and the linked client membership exist.

Screen tests drive the same form builders the screens use (`packages/shared/src/forms.ts`), so web, phone and e2e agree on the request shapes.

## Notes

- The repository's `.npmrc` sets `legacy-peer-deps=true`, because React Native Testing Library 13 and React Native 0.86 declare overlapping React peer ranges. Peer dependencies the tools need (such as Vite for Vitest) are therefore listed explicitly. Use `npm ci` with the committed lockfile.
- A fresh database: `npm run db:migrate` on an empty database. Migrations are checksummed, so never edit an applied one; add the next number instead.
