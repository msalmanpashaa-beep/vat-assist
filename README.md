# VAT Assist

Phone-first VAT compliance for Mauritian shops, with every return reviewed and signed off by a Chartered Accountant at Nex-Gen Africa.

The owner photographs bills, records the day's takings and sends customers a pay link. The app keeps double-entry books, shows the VAT Pot (money set aside for MRA), and prepares a return for a reviewer. A senior reviewer signs it off with a fingerprint. The owner then files on MRA e-Services by following an in-app guide and attaches MRA's acknowledgement.

## What is in this repository

| Part | Path | Stack | Status |
|---|---|---|---|
| API | `packages/api` | NestJS 12, Postgres 16 with row-level security, plain SQL | Builds; 55 unit tests; 21 end-to-end tests (2 of them over real SMTP) and the 18-step demo pass against a real database |
| Shared | `packages/shared` | TypeScript: money, VAT, MRA calendar, i18n (en/fr/Kreol), contracts, form builders | Builds; 25 unit tests |
| Web console | `apps/web` | Next.js 16 (App Router): reviewer, owner, admin, public pay page | Production build passes; 15 screen tests |
| Phone app | `apps/mobile` | Expo SDK 57, Expo Router | Type-checks; 12 screen tests (Jest); Android bundle builds; not yet run on a device |

`docs/demo/` holds the transcript of the last end-to-end run and the filing-pack PDF it produced.

## Run it locally

You need Node 22 and Docker (for Postgres, Redis and MinIO).

```
npm install
npm run infra:up
cp .env.example .env
#   in .env set:
#   JWT_SECRET=$(openssl rand -hex 48)
#   DATA_ENCRYPTION_KEY=$(openssl rand -base64 32)
npm run build
npm run db:migrate
npm run db:seed          # Nex-Gen platform org + three staff logins (credentials in packages/api/demo-output/)
npm run dev:api          # http://localhost:4000
npm run demo             # in a second terminal: the whole story, self-checking
npm run dev:web          # http://localhost:3000  (reviewer console, owner view, public pay page)
npm run dev:mobile       # Expo; set EXPO_PUBLIC_API_URL=http://<your-LAN-IP>:4000 for a phone on Wi-Fi
```

In development nothing leaves the machine. Staff invite emails print in the API log; production sends them from Nex-Gen's own cPanel mailbox over SMTP, or through Postmark, Resend or Microsoft 365 (`MAIL_PROVIDER`, see `DEVELOPMENT.md`). SMS codes are fixed at `000000`, messages print to the API log, and invoices are read by a deterministic stand-in. Card payments are simulated, but the real signature and decryption code paths run.

## The demo

`npm run demo` drives the real API over HTTP as each person and stops at the first wrong number:

1. The owner signs in by SMS code (in Kreol) and sets up the business. MRA deadlines are worked out automatically: Q3 2026 is due 20/10/2026, or 03/11/2026 if filed and paid electronically.
2. Opening balances are entered. Admin, reviewer and senior reviewer sign in with password plus authenticator.
3. The owner photographs four bills:
   - a clear invoice posts by itself;
   - a handwritten receipt with no supplier VAT number goes to review;
   - a re-sent photo is caught as a duplicate;
   - a blurred photo is refused.
4. One day's takings and a sales invoice on credit are recorded.
5. Getting paid, on every rail:
   - Juice with a screenshot, confirmed by the owner;
   - a bank-transfer claim that never arrived, rejected;
   - card through MIPS, confirmed by its encrypted IMN;
   - the Rs 25 booking deposit by card through Stripe. Forged callbacks are refused and repeats ignored.
6. Ageing and the VAT Pot: Rs 1,500 − Rs 990 = Rs 510 to set aside.
7. Review and sign-off: a question to the owner, the answer, approval, draft return. The reviewer is refused sign-off; the senior reviewer signs and the period locks.
8. Late invoices land in the next period, flagged.
9. Filing: filing guide and PDF, MRA acknowledgement, payment, close.
10. Reminders, tenant isolation, and the audit hash chain.

## Layout

```
packages/shared     money, VAT maths, MRA dates, i18n, request contracts
packages/api        src/modules: auth, orgs, ledger, documents, vat, review, payments, notifications, admin
                    migrations/  0001–0011 (schema, RLS, payment rails)
                    test/        unit tests (vitest)
apps/web            reviewer console, owner view, public pay page (/pay/<token>)
apps/mobile         owner app: capture, sales, VAT Pot, money, returns, payments
docs                ARCHITECTURE.md, DECISIONS.md (open questions), demo/
```

## Tests

```
npm test                                   # shared + api unit tests
npm run typecheck                          # every package
```

`DEVELOPMENT.md` covers running the owner and admin screens, feature flags and every test suite. Read `docs/DECISIONS.md` before going live. It lists what is assumed, what is unverified, and what needs a decision.
