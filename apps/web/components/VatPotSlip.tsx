import type { VatPot } from '@vat-assist/shared';
import { day, rs } from '@/lib/format';

/** MRA's copy of the till: the VAT collected minus VAT paid, as the yellow duplicate slip. */
export function VatPotSlip({ pot }: { pot: VatPot }) {
  const credit = pot.creditCarriedForwardCents > 0;
  return (
    <section className="slip" aria-label={`VAT Pot for ${pot.periodLabel}`}>
      <div className="label">{credit ? `Credit to carry forward, ${pot.periodLabel}` : `Keep aside for MRA, ${pot.periodLabel}`}</div>
      <div className="amount">{rs(credit ? pot.creditCarriedForwardCents : pot.setAsideCents)}</div>
      <dl>
        <dt>VAT on sales</dt><dd>{rs(pot.outputVatCents)}</dd>
        <dt>VAT on purchases</dt><dd>−{rs(pot.inputVatCents)}</dd>
        {pot.creditBroughtForwardCents > 0 && (<><dt>Credit from last return</dt><dd>−{rs(pot.creditBroughtForwardCents)}</dd></>)}
        {pot.outputVatOnUnpaidSalesCents > 0 && (<><dt>Of which on sales not yet paid</dt><dd>{rs(pot.outputVatOnUnpaidSalesCents)}</dd></>)}
      </dl>
      <div className="due">Due {day(pot.dueStandard)}, or {day(pot.dueElectronic)} when filed and paid online</div>
    </section>
  );
}
