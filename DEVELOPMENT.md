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
  - It returns a one-time link valid for 7 days. No email provider is set up yet, so the admin sends the link.
  - The person then sets a password and an authenticator.
- **Reset 2FA:** removes the authenticator and ends all sessions; the person enrols again at next sign-in.
- **Temporary recovery code:** works once, within 24 hours, for someone whose authenticator is set up but unavailable. Issuing a new code retires the previous one.

## Tests

```
npm test                      # unit and screen tests: shared, api, web (Vitest + Testing Library), mobile (Jest + jest-expo)
npm run typecheck             # every package
npm run test:e2e              # end to end against a running API with the seed loaded (npm run dev:api first)
npm run demo                  # the original 18-step self-checking story
```

The end-to-end suite (`packages/api/test/e2e/owner-admin.e2e.ts`) creates its own business on every run. It covers:

- onboarding opening balances, snapping an invoice, a credit invoice, a customer payment and a supplier payment;
- ageing and journal updates;
- the reviewer query flow;
- the reminder and WhatsApp toggles;
- invites, assignments, 2FA reset with a temporary code, disabling staff, and feature flags.

Screen tests drive the same form builders the screens use (`packages/shared/src/forms.ts`), so web, phone and e2e agree on the request shapes.

## Notes

- `apps/mobile` testing packages were installed with `--legacy-peer-deps`. React Native Testing Library 13 and React Native 0.86 declare overlapping React peer ranges. Use `npm ci` with the committed lockfile.
- A fresh database: `npm run db:migrate` on an empty database. Migrations are checksummed, so never edit an applied one; add the next number instead.
