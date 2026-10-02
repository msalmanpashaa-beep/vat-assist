import type { Cents, Locale } from './money';
import type { IsoDate } from './dates';
import type { VatCode } from './vat';

export type Role = 'owner' | 'staff' | 'reviewer' | 'senior_reviewer' | 'admin' | 'support';
export type PeriodStatus = 'open' | 'in_review' | 'signed_off' | 'filed' | 'paid' | 'closed';
export type DocumentStatus =
  | 'uploading' | 'processing' | 'rejected_quality' | 'duplicate'
  | 'awaiting_owner' | 'needs_review' | 'posted' | 'archived' | 'failed';

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface MeResponse {
  user: { id: string; fullName: string | null; phone: string | null; email: string | null; locale: Locale };
  memberships: Array<{ orgId: string; orgName: string; role: Role }>;
}

export interface VatPot {
  periodId: string;
  periodLabel: string;
  startsOn: IsoDate;
  endsOn: IsoDate;
  status: PeriodStatus;
  outputVatCents: Cents;
  inputVatCents: Cents;
  creditBroughtForwardCents: Cents;
  setAsideCents: Cents;
  creditCarriedForwardCents: Cents;
  outputVatOnUnpaidSalesCents: Cents;
  dueStandard: IsoDate;
  dueElectronic: IsoDate;
}

export interface ReturnFigures {
  periodStart: IsoDate;
  periodEnd: IsoDate;
  sales: { standardRatedNet: Cents; zeroRatedNet: Cents; exemptNet: Cents; outOfScopeNet: Cents };
  outputVat: { onSales: Cents; reverseCharge: Cents; total: Cents };
  purchases: { standardRatedNet: Cents; zeroRatedNet: Cents; exemptNet: Cents; blockedOrNotClaimableGross: Cents; reverseChargeNet: Cents };
  inputVat: { local: Cents; lateClaims: Cents; reverseCharge: Cents; total: Cents };
  creditBroughtForward: Cents;
  netPayable: Cents;
  creditCarriedForward: Cents;
  counts: { salesDocs: number; purchaseDocs: number; lateDocs: number; openBlockingQueries: number };
}

export interface GuideStep {
  key: string;
  title: string;
  detail: string;
  amountCents?: Cents;
  /** MRA e-filing field this figure goes into. null until confirmed against the live MRA screen. */
  mraField?: string | null;
}

export interface ExtractionField<T> {
  value: T | null;
  confidence: number;
}

export interface ExtractedInvoice {
  documentType: 'vat_invoice' | 'invoice' | 'receipt' | 'till_report' | 'statement' | 'mra_letter' | 'other';
  hasVatInvoiceWords: boolean | null;
  supplierName: ExtractionField<string>;
  supplierVatNumber: ExtractionField<string>;
  supplierBrn: ExtractionField<string>;
  buyerName: ExtractionField<string>;
  buyerVatNumber: ExtractionField<string>;
  invoiceNumber: ExtractionField<string>;
  invoiceDate: ExtractionField<IsoDate>;
  currency: ExtractionField<string>;
  netCents: ExtractionField<Cents>;
  vatCents: ExtractionField<Cents>;
  totalCents: ExtractionField<Cents>;
  lines: Array<{ description: string; amountCents: Cents | null; vatCode: VatCode | null }>;
}

export interface PortfolioRow {
  orgId: string;
  orgName: string;
  periodId: string | null;
  periodLabel: string | null;
  periodStatus: PeriodStatus | null;
  dueStandard: IsoDate | null;
  docsNeedingReview: number;
  openQueries: number;
  riskScore: number;
}

/** One way to pay, as shown on the public pay page. */
export type PayMethodInfo =
  | { kind: 'card'; provider: 'mips' | 'stripe' }
  | { kind: 'juice'; mobile: string; name: string | null; qrUrl: string | null }
  | { kind: 'bank_transfer'; bankName: string | null; accountName: string | null; accountNumber: string | null; iban: string | null };

export interface PublicPaymentRequest {
  reference: string;
  payeeName: string;
  description: string;
  amountCents: number;
  currency: string;
  status: 'open' | 'paid' | 'cancelled' | 'expired';
  expiresAt: string;
  methods: PayMethodInfo[];
  pendingConfirmation: boolean;
}

export type CardCheckoutResponse = { kind: 'redirect'; url: string } | { kind: 'html'; html: string };
