# Demo script (about 15 minutes)

The order is onboarding → snap invoice → extraction → posting → VAT Pot → reviewer query → sign-off → Stripe payment → Twilio reminder → return builder → deploy.

The same story runs automatically, with every number checked: `npm run demo:pitch` (transcript in `docs/demo/demo-pitch.txt`). Use it as a rehearsal, or as the fallback if anything goes wrong live.

## Before the audience arrives

- `npm run infra:up`, `npm run build`, `npm run db:migrate`, `npm run db:seed`, `npm run dev:api`, `npm run dev:web`. Have the phone app open (or the web owner view) and the reviewer console signed in.
- Have a printed or on-screen invoice from "Grossiste Demo Ltd" ready to photograph. In development the stand-in reader recognises the demo file names; the automated run uses those.
- Optionally run `npm run demo:pitch` once, so the reminder and filing steps have data to show.

## The talk track

1. **Onboarding (1.5 min).** *Phone.* Sign in with the mobile number; the code arrives by SMS (in development it is `000000`). Choose Kreol. Enter the business, then the opening balances: cash, MCB account, stock.
   - Say: "Ten minutes on the onboarding call, and the books start from the right numbers."
   - Point at: the first deadline shown, 20/10/2026, or 3/11 if they file and pay online.
2. **Snap an invoice (1 min).** *Phone.* Photograph the supplier invoice.
   - Say: "Blurred photos and duplicates are refused on the spot, before anyone wastes time on them."
3. **Extraction (1 min).** *Phone.* Show what was read: supplier and VAT number, invoice number, date, Rs 4,000 + Rs 600 VAT, 97% confident, nothing flagged.
   - Say: "It checks the VAT maths, the supplier's VAT number, who the invoice is addressed to, and the claim deadline."
4. **Posting (1 min).** *Phone.* Two questions: on credit or paid now (on credit), and what it is for (stock to resell). Posted.
   - Say: "The owner answers two questions. The double entry, the VAT code and the supplier balance are done for them."
5. **VAT Pot (1 min).** *Phone home screen.* The yellow slip shows VAT on sales Rs 1,500 − VAT on purchases Rs 600 = Rs 900 to set aside.
   - Say: "This is MRA's copy of the money in the till, so the owner never spends it."
6. **Reviewer query (2 min).** *Reviewer console, then phone.* A receipt with no supplier VAT number lands in the queue. The reviewer asks, the owner answers in Kreol, the reviewer approves (VAT treated as a cost) and resolves.
   - Say: "Only the exceptions reach the accountant. That's how review stays under 20 minutes a quarter."
7. **Sign-off (1.5 min).** *Reviewer console.* Prepare the draft: Rs 900 payable. A reviewer can't sign; the senior reviewer signs. The period locks with a fingerprint.
   - Say: "The figures come only from the ledger. If anything changes after the draft, sign-off is refused."
8. **Stripe payment (1 min).** *Phone, then Stripe checkout.* Book the onboarding call and pay the Rs 25 deposit by card.
   - Say: "A forged payment notice is rejected; the real one confirms the booking and books Rs 3.26 VAT in Nex-Gen's own books."
   - Mention that Juice and bank transfer work on the same pay link.
9. **Twilio reminder (1 min).** *Screen or phone.* The evening before 20 October the owner gets an SMS in Kreol, e.g. "Demin (20/10/2026) dernie zour pou deklarasion VAT Q3 2026 … Montan pou met de kote: Rs 900,00."
   - Say: "Sent once, at 9 in the morning, in the owner's language."
10. **Return builder (2 min).** *Phone guide, then PDF.* The step-by-step filing guide shows each box with its amount. Open the filing pack PDF. Photograph MRA's acknowledgement, record the payment, and the period closes.
    - Say: "The owner files on MRA with our numbers, and keeps proof of everything for six years."
11. **Deploy (1 min).** *GitHub.* Show a green CI run, then the Deploy run waiting for approval: migrations, API image, Vercel. Show `npm run config:check -- ../../.env.production.example --template`: every production rule passes and the secrets to fill are listed.
    - Say: "Nothing reaches production unless every test passes and I approve it."

## If something goes wrong live

- **The phone won't connect:** switch to the web owner view (`/owner/login`).
- **The reader or uploads misbehave:** use the automated run (`npm run demo:pitch`), or show the transcript and `docs/demo/pitch-filing-pack-Q3-2026.pdf`.
- **Reset for a clean run:** `npm run db:migrate` on a fresh database, then `npm run db:seed`.
