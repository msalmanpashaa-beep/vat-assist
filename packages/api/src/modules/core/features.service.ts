import { Injectable } from '@nestjs/common';
import { FEATURES, type FeatureKey, type FeatureSet, resolveFeatures } from '@vat-assist/shared';
import { DomainError } from '../../common/errors';
import { Db } from '../../db/db.service';

/** Per-organisation switches set by Nex-Gen admins. Enforced here, on the server, not just hidden in the UI. */
@Injectable()
export class FeaturesService {
  constructor(private readonly db: Db) {}

  async get(orgId: string): Promise<FeatureSet> {
    const rows = await this.db.run({ kind: 'system', orgId }, (tx) =>
      tx.many<{ feature: string; enabled: boolean }>(`select feature, enabled from org_features where org_id = $1`, [orgId]),
    );
    return resolveFeatures(Object.fromEntries(rows.map((r) => [r.feature, r.enabled])));
  }

  async require(orgId: string, key: FeatureKey): Promise<void> {
    if (!(await this.get(orgId))[key]) {
      throw new DomainError('feature_disabled', `${FEATURES[key].label} is switched off for this business. Ask Nex-Gen to turn it on.`, 403);
    }
  }
}
