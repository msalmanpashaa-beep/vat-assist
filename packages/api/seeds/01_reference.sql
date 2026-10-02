-- Reference data. Run as vat_owner. Sources are recorded on each rule; verified_by_reviewer stays false
-- until a Nex-Gen Chartered Accountant has checked the rule against the Act (see docs/DECISIONS.md).
insert into vat_codes (code, description, input_claimable, mra_supply_type) values
  ('SR', 'Standard-rated (15%)', true, 'TC01'),
  ('ZR', 'Zero-rated (0%)', true, 'TC02'),
  ('EX', 'Exempt', false, 'TC03'),
  ('OS', 'Outside the scope of VAT', false, 'TC06'),
  ('RC', 'Reverse charge, s.14 VAT Act (imported services)', true, null),
  ('BL', 'VAT paid but blocked by s.21(2) VAT Act', false, null),
  ('NC', 'VAT paid but not claimable (no valid VAT invoice, personal use, claim window passed)', false, null)
on conflict (code) do nothing;

insert into vat_rules (key, value, valid_from, valid_to, source_url, note) values
  ('standard_rate_bp', '1500', '2020-01-01', null, 'https://lookuptax.com/docs/country/mauritius-vat-guidelines-indirect-tax', 'Earlier history not modelled'),
  ('registration_threshold_cents', '600000000', '2020-01-01', '2025-09-30', 'https://lookuptax.com/docs/country/mauritius-vat-guidelines-indirect-tax', 'Rs 6M'),
  ('registration_threshold_cents', '300000000', '2025-10-01', null, 'https://lookuptax.com/docs/country/mauritius-vat-guidelines-indirect-tax', 'Rs 3M from 1 Oct 2025 (Finance Act 2025)'),
  ('monthly_filing_threshold_cents', '1000000000', '2020-01-01', null, 'https://lookuptax.com/docs/country/mauritius-vat-guidelines-indirect-tax', 'Monthly returns above Rs 10M turnover'),
  ('input_claim_window_months', '36', '2020-01-01', '2026-08-12', 'https://lookuptax.com/docs/country/mauritius-vat-guidelines-indirect-tax', 'Window in force when the claim is made'),
  ('input_claim_window_months', '24', '2026-08-13', null, 'https://lookuptax.com/docs/country/mauritius-vat-guidelines-indirect-tax', 'Cut from 36 to 24 months (Finance Act 2026)'),
  ('time_of_supply_backstop_months', '3', '2026-10-01', null, 'https://lookuptax.com/docs/country/mauritius-vat-guidelines-indirect-tax', 'Supply deemed made 3 months after delivery if not invoiced or paid earlier'),
  ('return_due_days', '20', '2020-01-01', null, 'https://www.mra.mu/index.php/important-dates', 'Electronic filing+payment: end of following month; May/Nov: 2 working days before end of June/Dec'),
  ('record_retention_years', '5', '2020-01-01', null, 'https://lookuptax.com/docs/country/mauritius-vat-guidelines-indirect-tax', 'Documents kept 6 years by policy'),
  ('penalty_late_return', '{"per_month_cents": 200000, "cap_cents": 2000000, "small_enterprise_cap_cents": 500000}', '2020-01-01', null, 'https://lookuptax.com/docs/country/mauritius-vat-guidelines-indirect-tax', null),
  ('penalty_late_payment_bp', '{"standard": 1000, "small_enterprise": 200}', '2020-01-01', null, 'https://lookuptax.com/docs/country/mauritius-vat-guidelines-indirect-tax', null),
  ('interest_bp_per_month', '100', '2020-01-01', null, 'https://lookuptax.com/docs/country/mauritius-vat-guidelines-indirect-tax', null),
  ('penalty_failure_to_register', '{"per_month_cents": 500000, "cap_cents": 5000000}', '2020-01-01', null, 'https://lookuptax.com/docs/country/mauritius-vat-guidelines-indirect-tax', null),
  ('penalty_fiscal_invoice', '{"per_day_cents": 500000, "cap_cents_per_12_months": 100000000}', '2026-10-01', null, 'https://lookuptax.com/docs/country/mauritius-vat-guidelines-indirect-tax', 'Failure to issue a fiscal (e-)invoice'),
  ('einvoicing_phases', '[{"from":"2024-05-15","turnover_over_cents":10000000000,"who":"Large Taxpayer Department"},{"from":"2025-08-01","turnover_over_cents":10000000000,"who":"MSTD"},{"from":"2026-06-30","turnover_over_cents":8000000000},{"from":"2026-09-01","turnover_over_cents":4000000000}]', '2024-05-15', null, 'https://lookuptax.com/docs/country/mauritius-vat-guidelines-indirect-tax', 'DG may notify any person (s.20A(2))')
on conflict do nothing;

-- 2 Nov 2026 is confirmed by MRA moving the 31 Oct e-filing deadline to Tuesday 3 Nov.
-- The others are fixed-date holidays still to be checked against the Government Notice for the year;
-- moveable feasts (Cavadee, Maha Shivaratree, Spring Festival, Ougadi, Eid, Ganesh Chaturthi, Divali)
-- must be loaded from that notice — never guessed.
insert into public_holidays (holiday_date, name, verified, source) values
  ('2026-11-02', 'Arrival of Indentured Labourers', true, 'Inferred from MRA tax calendar Jul–Dec 2026'),
  ('2026-12-25', 'Christmas', false, 'Fixed-date; verify yearly notice'),
  ('2027-01-01', 'New Year', false, 'Fixed-date; verify yearly notice'),
  ('2027-01-02', 'New Year', false, 'Fixed-date; verify yearly notice'),
  ('2027-02-01', 'Abolition of Slavery', false, 'Fixed-date; verify yearly notice'),
  ('2027-03-12', 'Independence and Republic Day', false, 'Fixed-date; verify yearly notice'),
  ('2027-05-01', 'Labour Day', false, 'Fixed-date; verify yearly notice')
on conflict (holiday_date) do nothing;
