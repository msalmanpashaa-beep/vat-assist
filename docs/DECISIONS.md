# Decisions and open questions

Items marked **Decide** need Nex-Gen's call. **Verify** means the code makes an assumption that must be checked before launch. **Later** means deliberately out of scope for this version.

## Payments

1. **Decide: whose merchant account takes card payments for shop invoices.**
   - Today the MIPS and Stripe credentials are server-wide, which means Nex-Gen's merchant account. That is right for Nex-Gen's own booking deposits.
   - For a shop's customer invoices it would put the shop's money through Nex-Gen. That is collecting funds for others, which raises Bank of Mauritius licensing questions.
   - Options:
     - (a) Each shop gets its own MIPS merchant or entity. Ask MIPS whether one platform merchant can hold an entity per shop that settles to the shop's own account; the code would then store per-shop credentials, encrypted.
     - (b) Offer cards only for Nex-Gen's own fees until then.
   - Juice and bank transfers already go straight to the shop and Nex-Gen never touches the money.
2. **Verify with MIPS at onboarding:**
   - the IMN request field name (`MIPS_IMN_FIELD`, default `crypted_callback`; the handler also accepts the raw body);
   - the `touchpoint` value for web checkout (`MIPS_TOUCHPOINT`, default `web`);
   - the allowed `id_order` format (we send `VAxxxxxx-01`).
   - MIPS posts the IMN only on success, so abandoned card attempts stay pending and the payer can simply try again.
3. **Later: matching transfers automatically.**
   - No public MCB Juice merchant API was found, so Juice and bank transfers are confirmed by the shop.
   - The reference in the narration is designed for automatic matching once bank statements or feeds are imported.
4. **Later: QR codes.** The pay page can show a static QR code (from the shop's bank, MauCAS-compatible) through `payment_settings.qr_document_id`, but the apps do not yet have a screen to upload it.
5. **Decide: the deposit.** The default stays Rs 25 (VAT-inclusive: Rs 21.74 + Rs 3.26 VAT).
   - Paid by Juice or bank transfer, there are no card fees.
   - By card, the fixed fee may take a large share.
6. **Verify: proxies and storage CORS.**
   - Set `TRUST_PROXY_HOPS` to the real number of proxies in front of the API; rate limits key on the client IP.
   - For S3 or MinIO, allow the web origin in the bucket's CORS so the pay page can upload screenshots.

## Tax and MRA

7. **Decide: Nex-Gen's own VAT registration.** Accountants and consultants are listed in the Tenth Schedule as registering whatever their turnover. The demo treats Nex-Gen as registered (placeholder VAT number 99999901).
8. **Verify: MRA e-filing box numbers.** The filing guide and PDF match fields by description (`mraField: null`) until checked against the live form.
9. **Verify: public holidays.** Only 2 Nov 2026 is confirmed in the seed; the rest need MRA or Government confirmation each year. A holiday moves a deadline to the next working day.
10. **Verify: MRA list of VAT-registered persons.** It is loaded from MRA's quarterly PDF converted to CSV (`POST /admin/mra-registered-persons`). A supplier missing from it gets a warning, not a block.
11. **Later: invoices made in the app are not MRA fiscal e-invoices.** Integrate with MRA's e-invoicing system when the shop's phase applies.
12. **Later: the small-enterprise annual accounting scheme** (turnover up to Rs 10M) could suit many shops. It is not modelled yet.

## Product and compliance

13. **Verify: Kreol text** (app, SMS templates, category names) with a native speaker before launch.
14. **Decide: WhatsApp.**
    - Business-initiated messages need Meta-approved templates, registered in Twilio with the same variables.
    - Kreol may not be an accepted template language, so Kreol users get SMS.
15. **Verify: the Data Protection Act 2017.**
    - Invoice images go to an AI vendor for reading. This needs a lawful basis, a processing agreement, and a transfer assessment.
    - The mock reader keeps everything local in development.
16. **Later: reopening a signed-off period.** Corrections go through the next period as late items. That keeps the signed return intact but has no "reopen" button.
17. **Later: rate limits are per process, in memory.** Move them to Redis before running more than one API instance.
18. **Policy: retention.** Documents are kept 6 years, beyond the 5-year legal minimum.

## Owner and admin screens

19. **Decided (for now): staff invites go out from `connect@nex-gen.africa` over SMTP** (`mail.nex-gen.africa`, port 465, cPanel).
    - Still to do: confirm SPF and DKIM in Email Deliverability; add DMARC; set `SMTP_PASS` on the host only; send a test email; ask the host for the hourly sending limit.
    - A dedicated `invites@` mailbox later would keep the main password off servers.
20. **Policy: staff recovery.** Admin-issued temporary codes work once, within 24 hours, and need an authenticator that was set up. For a lost phone, use Reset 2FA instead. Both actions are recorded in the audit trail.
21. **Decide: feature flag defaults.** All five flags default to on (`packages/shared/src/features.ts`). Switch a flag's default off to roll a screen out to pilot shops only.
22. **Verify: customer consent for reminders.** Invoice reminders go only to customers with a mobile number and recorded consent. Confirm the consent wording with the Data Protection Act review.

## Deployment and pilot

23. **Decide: the API host.** Any container host that runs an image from GitHub's registry, keeps secrets, checks `/health` and offers a deploy hook will do: Render, Railway, Fly.io, DigitalOcean App Platform. Choose on price, region and support.
24. **Decide: where the data lives.** The database, Redis and the S3 bucket should sit in one region; AWS `af-south-1` (Cape Town) is the closest AWS region. Data leaves Mauritius either way, so complete the Data Protection Act 2017 transfer assessment (item 15) before real shops are onboarded.
25. **Verify: the Vercel plan.** Vercel's Hobby plan is for non-commercial use, so a paid pilot needs Pro.
26. **Decide: pilot targets.** Reviewer time under 20 minutes per shop per quarter is set. The others are proposals in `docs/PILOT.md`: activation ≥ 80% within 14 days, on-time filing ≥ 95%, churn ≤ 10%, ≥ 3 referrals.
    - Reviewer minutes are estimated from recorded actions, so calibrate them against a stopwatch on a few shops in the first weeks.
27. **Later: phone app releases.** EAS builds and store submission are manual for now. For the pilot, Google Play internal testing and TestFlight are enough.

