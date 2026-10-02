# PR: Owner and admin screens, reminder and WhatsApp toggles, per-business feature flags

## Summary

Adds the screens that were API-only:

- **Owner:** opening balances, credit sales invoices, customer payments, supplier payments.
- **Admin:** staff invites, reviewer assignment with bulk reassign, 2FA reset, temporary recovery codes.
- **Settings:** an owner switch for customer invoice reminders, and WhatsApp opt-in with recorded consent.

Every new screen is behind a per-business feature flag managed in the admin console. Screens exist on web and phone, use the existing UI components, and share request builders with the end-to-end tests.

## Changes

- **Database (0012):**
  - `org_features`, `staff_invites`, `staff_recovery_codes` (one use, 24 hours);
  - `outbound_messages.user_id`, `transaction_id` and the `cancelled` status;
  - the WhatsApp consent version;
  - admin functions (`admin_invite_staff`, `admin_staff_list`, 2FA reset, enable and disable) that check the caller is a platform admin.
- **API:**
  - `GET /orgs/:id/features`, `/opening-balances`, `/balances`;
  - `GET`/`PATCH /orgs/:id/settings`, which schedules or cancels reminders;
  - `POST /orgs/:id/whatsapp-consent` and contacts endpoints;
  - admin `staff`, `clients`, `assignments/bulk`, `features`, and `auth/staff/invite/accept`.
  - Flags are enforced on opening balances, credit invoices, payments and the toggles.
- **Shared:** form builders (`forms.ts`), the feature registry, consent text, and en/fr/Kreol strings.
- **Web:** owner pages under `/owner/[orgId]/…`, the admin console under `/admin/…`, and invite acceptance at `/invite/[token]`.
- **Mobile:** opening balances, new invoice, record payment (customer or supplier), settings and the WhatsApp consent screen. Inputs now carry accessibility labels.

## Acceptance criteria

| Criterion | Evidence |
|---|---|
| Opening balances entered from onboarding persist | e2e "onboarding: business details, then opening balances…"; phone and web screen tests |
| Credit invoice from the owner UI appears in ageing | e2e "create a credit invoice from the form: it lands in the 0-30 bucket"; screen tests |
| Customer and supplier payments update journal and ageing | e2e payment cases check ageing and account balances; screen tests check allocations |
| Admin can invite, assign reviewers and reset 2FA | e2e "admin console" (5 cases); web admin screen tests |
| Reminder toggles persist and schedule or cancel jobs | e2e "switching invoice reminders on schedules them… off cancels"; phone settings tests |

## How to test

See `DEVELOPMENT.md` and `docs/DEMO-SCREENS.md`.

```
npm test                 # unit and screen tests
npm run test:e2e         # with the API running and seeded
```

## Notes and follow-ups

- **Email:** no provider is configured. Invite links are shown to the admin, who sends them; a provider is a decision in `docs/DECISIONS.md`.
- **Kreol:** the strings for the new screens need a native speaker's review.
- **Phone app:** the screens are covered by Jest screen tests and type-checks, but not yet run on a physical device.
- **Install:** mobile test packages use `--legacy-peer-deps` (a React peer-range overlap); the lockfile is committed.
