# Architecture

One deployable API (a modular monolith), two clients, one Postgres database. Modules talk through services, never through each other's tables, so any of them can be split out later.

```
 Phone app (Expo) ─┐                         ┌─ Stripe / MIPS (cards, wallets)
 Web console ──────┼─ HTTPS ─ NestJS API ────┼─ Twilio (SMS, WhatsApp, Verify)
 Public pay page ──┘          │   │          └─ Anthropic (reading invoices)
                              │   └─ S3-compatible storage (documents, presigned upload/download)
                              └─ Postgres 16 (RLS per organisation) + Redis/BullMQ (jobs, optional in dev)
```

## Tenancy and security

- Every business is an organisation. Every row carries `org_id`.
- The API connects as `vat_app`, which has no BYPASSRLS. Policies call `app.scope_org_ids()`, which reads the transaction-local settings `app.user_id`, `app.org_id` and `app.context`:
  - `user`: the signed-in person's memberships;
  - `system`: jobs and webhooks, pinned to one organisation;
  - `auth`: sign-in only.
- Requests that arrive without a user (public pay links, provider callbacks) first find their organisation through narrow `SECURITY DEFINER` lookups, then work pinned to it.
- Owners and shop staff sign in by SMS code. Nex-Gen staff use email, password (argon2id) and an authenticator, with recovery codes.
  - Access tokens last 15 minutes.
  - Refresh tokens rotate. Reusing an old one revokes the whole family.
- Authenticator secrets are stored with AES-256-GCM. Rate limits sit on every sign-in and public endpoint.

## Books

```
 document / takings / invoice / payment
          │  posting rules (pure functions, unit-tested)
          ▼
 journal entry ── lines (debit = credit, enforced at commit by a deferred trigger)
          │
          ├─ immutable: corrections are reversals (void) plus a new entry
          ├─ period: the VAT period of the date, or the next open one if that period is
          │  signed off (flagged late, with the reason); a late SALE raises a blocking question
          └─ audit event: hash-chained per organisation (each event hashes the previous one)
```

VAT codes:

| Code | Meaning |
|---|---|
| SR | Standard 15% |
| ZR | Zero-rated |
| EX | Exempt |
| OS | Outside scope |
| RC | Reverse charge, s.14 |
| BL | Blocked input, s.21(2) |
| NC | Not claimable (no valid VAT invoice) |

Input VAT older than the claim window (24 months from 13 Aug 2026; effective-dated in `vat_rules`) is refused. The reviewer can instead post it as cost.

## Documents

```
 phone → presigned upload → complete → quality check (size, sharpness, light)
   → SHA-256 exact duplicate → perceptual hash (dHash) near duplicate, counted only when the
     amount, number or date also match → extraction (Anthropic, forced tool output; mock in dev)
   → checks (VAT maths, supplier VAT number, buyer, claim window, MRA list) → confidence score
   → owner answers two questions (paid now/later, what for)
   → post automatically when confident, else reviewer queue
```

## VAT returns

```
 open → in_review (owner taps "done", or reviewer drafts) → signed_off (senior reviewer)
      → filed (MRA acknowledgement attached) → paid → closed
```

- Figures are always rebuilt from the journal; nobody types totals in.
- Each draft is versioned. The fingerprint is a SHA-256 over the figures plus the exact list of entries behind them.
- Sign-off re-derives the fingerprint and refuses if the books moved since the draft, or if blocking questions are open.
- Filing posts a settlement entry into the next period, moving the period's VAT to "VAT payable to MRA". Paying clears it against the bank.

## Getting paid

```
 shop: "pay link" for an invoice (or Nex-Gen: booking deposit)
   └─ payment_request: amount, reference VAxxxxxx, token (hash stored), expiry
        ├─ card ── MIPS: payment zone (iframe) → IMN (encrypted) → decrypt via MIPS → settle
        │          Stripe: hosted checkout → signed webhook → settle
        ├─ Juice ─ payer sends to the shop's number with the reference → "I've paid" (+ screenshot)
        └─ bank ── payer transfers to the shop's account with the reference → "I've paid"
                      └─ owner is told by SMS → confirms when the money shows → settle
 settle = receipt against the invoice (or VAT-inclusive deposit for Nex-Gen), request marked paid
```

Each rail posts to its own account so it can be reconciled:

| Rail | Account |
|---|---|
| Juice | Juice clearing |
| Bank transfer | Bank |
| MIPS | MIPS clearing |
| Stripe | Stripe clearing |

Provider callbacks are deduplicated in `webhook_events`. A permanently bad event (unknown order, wrong amount) is acknowledged and logged rather than retried forever.

## Jobs and messages

With `REDIS_URL` set, document processing and the reminder tick (every 15 minutes) run on BullMQ. Without it they run inline, which is fine for development.

Reminders go out at 09:00 Mauritius time on the day before. Each message has an idempotency key and is never sent twice. WhatsApp is used only for users who opted in and only with an approved template; otherwise SMS. STOP or ARRET opts a number out.
