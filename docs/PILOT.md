# Pilot: 10 shops, one VAT quarter

The pilot proves that a Mauritian shop can run its VAT on the phone with a Chartered Accountant's review, while that review stays under 20 minutes per shop per quarter. It runs for one full VAT quarter, from onboarding to filing the return. The live scorecard is **Admin → Pilot**, for cohort `pilot-1`.

## Targets

| Metric | Definition (as computed) | Target | Where |
|---|---|---|---|
| Shops | Businesses tagged `pilot-1` | 10 | Admin → Pilot |
| Activation | Within 14 days of sign-up: opening balances, at least 5 documents captured, and at least one day of sales | ≥ 80% (8 of 10)* | Admin → Pilot |
| Reviewer minutes | Per shop per calendar quarter, estimated from reviewers' recorded actions (see below) | < 20 per shop (set) | Admin → Pilot |
| On-time filing | Returns filed by the deadline that applies, divided by returns due | ≥ 95%* | Admin → Pilot |
| Churn | Subscription cancelled, or no owner activity for 45 days | ≤ 10% (at most 1 shop)* | Admin → Pilot |
| Referrals | New shops that signed up with a pilot shop's referral code | ≥ 3 in the quarter* | Admin → Pilot |

\* Proposed; agree them before day one. Reviewer minutes under 20 is set.

**How the measures are worked out:**

- **Reviewer minutes:** a reviewer's recorded actions are grouped into sittings, and actions more than 15 minutes apart start a new sitting. Each sitting counts its length plus 3 minutes of reading. In weeks 2 to 3, time three shops' reviews with a stopwatch and compare. If the estimate is off by more than 20%, adjust the two constants in `packages/api/src/modules/admin/pilot-metrics.ts`.
- **On-time filing:** the deadline is the electronic one (for example 3 November for Q3 2026) when the shop files and pays online, otherwise the standard one (20 October). Weekends and holidays move it as MRA's calendar does.
- **Referrals:** every shop sees its referral code (format `NX` plus 6 characters) in Settings on the phone and on the owner web page. A new shop types it at sign-up, in any case.

## Before day one

1. [ ] Production deployed (`docs/DEPLOYMENT.md`): bootstrap done, admin signed in, test email received, `/health` shows the current commit.
2. [ ] Sign-in codes by SMS arrive on all three Mauritian mobile networks; test one number on each.
3. [ ] MRA e-filing box numbers checked against the live form before the first return (decision 8).
4. [ ] Kreol and French text reviewed by a native speaker (decision 13).
5. [ ] Data protection:
   - a privacy notice;
   - consent wording for reminders and WhatsApp;
   - processing agreements with Anthropic, Twilio and the hosts;
   - a transfer assessment (decisions 15 and 24).
6. [ ] Pilot terms for the shops: price (or free), what Nex-Gen does, response time for questions, how to leave.
7. [ ] Reviewer capacity: named reviewer and senior reviewer; questions answered within one working day.
8. [ ] Support line (WhatsApp or phone) and a one-page guide in Kreol and French.
9. [ ] Ten shops chosen (below), tagged `pilot-1` in Admin → Pilot (choose "All clients", then "Add to pilot-1").
10. [ ] Backups: one restore tested.

## Choosing the 10 shops

- VAT-registered and filing quarterly.
- A mix of trades (grocery, hardware, food, services) and of places.
- An owner or manager who uses a smartphone daily and will take a 5-minute weekly call.
- At least two with messy paperwork today (the pilot must work for them too) and at least two that pay or get paid by Juice.
- Not all from one referral circle, so that referrals mean something.

## Timeline

| When | What |
|---|---|
| Week 0 | 30-minute onboarding call per shop: install, sign in, business details, opening balances on the call, first invoice photographed together |
| Weeks 1–2 | Activation: daily takings and photos. Call any shop not activated by day 10 |
| Weeks 3–12 | Normal use. Reviewers clear the queue twice a week and answer questions within one working day |
| Quarter end | The owner taps "I'm done". Reviewer drafts, senior reviewer signs off, owner files with the guide and attaches MRA's acknowledgement |
| Week after filing | Retrospective with each shop (NPS question, top three frustrations), then the go / extend / stop decision |

## Weekly routine (Monday, 30 minutes)

1. Open Admin → Pilot for `pilot-1`:
   - call any shop marked "No" for activation, or with no owner activity for 14 days;
   - look into any shop whose reviewer minutes are rising toward 20.
2. Review queue and open questions: anything older than one working day?
3. Note each weekly call's feedback in one shared document (date, shop, issue, severity).

## Decision at the end

| Outcome | When |
|---|---|
| **Go:** open the next cohort (`pilot-2`) | Every target met, or missed narrowly for a reason that is fixed |
| **Extend** one more quarter | On-time filing ≥ 90% and the problems are known and fixable |
| **Stop and rethink** | Activation under 50%, or reviewer minutes well over 20 for most shops |
