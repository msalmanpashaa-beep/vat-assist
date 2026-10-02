# Walkthrough: the owner and admin screens

Test data comes from `npm run demo:data`. It creates the business **Boutik Screens**:

- owner mobile `+23057100031`, code `000000`;
- customers **Hotel Demo Ltd** (mobile `+23057100021`, agreed to reminders) and **Restoran Demo** (no mobile);
- supplier **Grossiste Demo Ltd**, with bill **INV-0457** for Rs 4,600 on credit.

Opening balances are left for you to enter. Each step says what you should see.

1. **Opening balances.** Sign in as the owner. Onboarding opens the opening-balances screen. Enter:
   - Cash 15,000; MCB current account 250,000; stock 180,000;
   - Restoran Demo owes 1,200; Distributeur Demo is owed 3,450;
   - VAT credit 0.
   Save. You see the recorded summary. Money → customers owe Rs 1,200, dated the books' start date. Saving a second time is refused, and a reviewer adjusts opening balances instead.
2. **Snap an invoice.** On the phone, Snap a supplier bill. In development the stand-in reader only recognises the demo file names, so a real photo goes to the reviewer queue. That is expected; the e2e suite covers the automatic path.
3. **Credit invoice.** New invoice:
   - customer Hotel Demo Ltd; line "Catering supplies" Rs 4,000 at 15%;
   - due date in 30 days; reminders consent on.
   It shows **Captured: invoice INV-00001 for Rs 4,600.00…**, and customers owe Rs 5,800 with Rs 4,600 in 0–30.
4. **Customer payment.** Customer paid → Hotel Demo Ltd, Rs 2,000, Juice, "Oldest first". INV-00001 now shows Rs 2,600 outstanding, customers owe Rs 3,800, and the Juice balance rises by Rs 2,000.
5. **Supplier payment.** Pay a supplier → Grossiste Demo Ltd, Rs 4,600, Bank, "Oldest first". Owed to suppliers falls to Rs 3,450 (the opening balance), and the bank balance on the screen drops by Rs 4,600.
6. **Reminders.** Settings → Customer invoice reminders on. The screen reports how many are scheduled; it is 0 until an invoice is due tomorrow. Switch off: anything queued is cancelled.
7. **WhatsApp.** Settings → WhatsApp on. The consent screen opens; agree. Switch off again: it is recorded at once.
8. **Admin: assign the reviewer.** Sign in at `/login` as `admin@nexgen.test`. Clients → Boutik Screens → assign `reviewer@nexgen.test` as reviewer. Use bulk reassign to move several clients at once.
9. **Reviewer query.**
   - As the reviewer: open Boutik Screens → Questions → ask "Was INV-0457 stock for resale?"
   - As the owner: answer it from the phone (Home → Questions).
   - As the reviewer: Resolve.
10. **Staff.**
    - Staff → Invite: any email, role reviewer, optionally linked to Boutik Screens. Open the link in a private window, set a password and an authenticator, and keep the recovery codes.
    - Reset 2FA: they must enrol again at next sign-in.
    - Temporary code: it signs them in once, within 24 hours.
    - Disable, then enable.
11. **Feature flags.** Feature flags → Boutik Screens → switch off "Invoices on credit". New invoice disappears for the owner, and calling the API directly returns `403 feature_disabled`. Switch it back on.
