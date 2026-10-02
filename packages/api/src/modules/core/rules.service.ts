import { Injectable } from '@nestjs/common';
import { DEFAULT_STANDARD_RATE_BP, type IsoDate } from '@vat-assist/shared';
import type { Tx } from '../../db/db.service';

/** Reads effective-dated VAT rules (vat_rules). Rules are data, so a Finance Act change is a row, not a release. */
@Injectable()
export class RulesService {
  async value<T>(tx: Tx, key: string, on: IsoDate): Promise<T | null> {
    const r = await tx.maybe<{ v: T }>(`select app.rule($1, $2::date) as v`, [key, on]);
    return r?.v ?? null;
  }

  async standardRateBp(tx: Tx, on: IsoDate): Promise<number> {
    return (await this.value<number>(tx, 'standard_rate_bp', on)) ?? DEFAULT_STANDARD_RATE_BP;
  }

  async claimWindowMonths(tx: Tx, on: IsoDate): Promise<number> {
    return (await this.value<number>(tx, 'input_claim_window_months', on)) ?? 24;
  }

  async backstopMonths(tx: Tx, on: IsoDate): Promise<number | null> {
    return this.value<number>(tx, 'time_of_supply_backstop_months', on);
  }
}
