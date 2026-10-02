import type { Tx } from '../../db/db.service';

/** Find a contact by VAT number, then by normalised name; create it if new. */
export async function findOrCreateContact(
  tx: Tx,
  orgId: string,
  c: { name: string; kind: 'customer' | 'supplier'; vatNumber?: string | null; brn?: string | null; phone?: string | null },
): Promise<{ id: string; created: boolean; default_category: string | null; payment_terms_days: number | null }> {
  if (c.vatNumber) {
    const byVat = await tx.maybe<{ id: string; default_category: string | null; payment_terms_days: number | null }>(
      `select id, default_category, payment_terms_days from contacts where org_id = $1 and vat_number = $2 limit 1`,
      [orgId, c.vatNumber],
    );
    if (byVat) return { ...byVat, created: false };
  }
  const byName = await tx.maybe<{ id: string; default_category: string | null; payment_terms_days: number | null }>(
    `select id, default_category, payment_terms_days from contacts where org_id = $1 and name_normalised = app.normalise_name($2) limit 1`,
    [orgId, c.name],
  );
  if (byName) return { ...byName, created: false };
  const row = await tx.one<{ id: string }>(
    `insert into contacts (org_id, kind, name, vat_number, brn, phone_e164) values ($1, $2, $3, $4, $5, $6) returning id`,
    [orgId, c.kind, c.name, c.vatNumber ?? null, c.brn ?? null, c.phone ?? null],
  );
  return { id: row.id, created: true, default_category: null, payment_terms_days: null };
}
