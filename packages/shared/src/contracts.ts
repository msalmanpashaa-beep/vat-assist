import { z } from 'zod';
import { PURCHASE_CATEGORY_KEYS, type PurchaseCategoryKey } from './categories';

/** Request bodies, validated on the API and reused by the web and phone clients. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const cents = z.number().int().refine(Number.isSafeInteger, 'Amount too large');
const positiveCents = cents.refine((n) => n > 0, 'Must be more than zero');
const uuid = z.string().uuid();

export const LocaleSchema = z.enum(['en', 'fr', 'mfe']);
export const PaymentMethodSchema = z.enum(['cash', 'bank', 'juice', 'card']);
const categoryKeys = PURCHASE_CATEGORY_KEYS as [PurchaseCategoryKey, ...PurchaseCategoryKey[]];

export const StartOtpBody = z.object({ phone: z.string().min(6).max(20) });
export const VerifyOtpBody = z.object({
  phone: z.string().min(6).max(20),
  code: z.string().regex(/^\d{4,8}$/),
  locale: LocaleSchema.optional(),
});
export const StaffLoginBody = z.object({ email: z.string().email(), password: z.string().min(12).max(200) });
export const TotpCodeBody = z.object({ code: z.string().regex(/^(\d{6}|[A-Z0-9]{5}-[A-Z0-9]{5})$/) });
export const RefreshBody = z.object({ refreshToken: z.string().min(20) });

export const CreateOrgBody = z.object({
  legalName: z.string().min(2).max(200),
  tradingName: z.string().max(200).optional(),
  legalForm: z.enum(['sole_trader', 'company', 'partnership', 'other']),
  brn: z.string().max(20).optional(),
  vatNumber: z.string().regex(/^\d{8}$/, 'VAT number is the 8-digit TAN').optional(),
  vatRegisteredOn: isoDate.optional(),
  filingFrequency: z.enum(['monthly', 'quarterly']).default('quarterly'),
  filesAndPaysElectronically: z.boolean().default(true),
  startDate: isoDate,
  shopType: z.string().max(80).optional(),
  defaultLocale: LocaleSchema.default('en'),
});

const namedAmount = z.object({
  name: z.string().min(1).max(200),
  amountCents: positiveCents,
  date: isoDate.optional(),
  dueDate: isoDate.optional(),
  phone: z.string().max(20).optional(),
});

export const OpeningBalancesBody = z.object({
  cashInHandCents: cents.default(0),
  bankBalances: z.array(z.object({ name: z.string().min(1), amountCents: cents })).default([]),
  stockCents: cents.default(0),
  customersOwe: z.array(namedAmount).default([]),
  suppliersOwed: z.array(namedAmount).default([]),
  vatCreditCarriedForwardCents: cents.default(0),
  vatPayableUnpaidCents: cents.default(0),
});

export const DOCUMENT_KINDS = [
  'purchase_invoice', 'sales_invoice', 'till_report', 'bank_statement',
  'mra_letter', 'mra_acknowledgement', 'payment_proof', 'other',
] as const;
export const DOCUMENT_SOURCES = ['camera', 'gallery', 'pdf', 'whatsapp', 'web', 'system'] as const;

export const UploadUrlBody = z.object({
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  byteSize: z.number().int().positive(),
  source: z.enum(DOCUMENT_SOURCES),
  kind: z.enum(DOCUMENT_KINDS).default('purchase_invoice'),
  originalFilename: z.string().max(200).optional(),
});

export const SettlementSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('cash'), method: PaymentMethodSchema }),
  z.object({ mode: z.literal('credit'), dueDate: isoDate.optional() }),
]);

export const DocumentAnswersBody = z.object({
  settlement: SettlementSchema,
  category: z.enum(categoryKeys).optional(),
});

export const DailyTakingsBody = z.object({
  date: isoDate,
  lines: z
    .array(z.object({
      method: z.enum(['cash', 'card', 'juice', 'credit']),
      vatCode: z.enum(['SR', 'ZR', 'EX']),
      grossCents: positiveCents,
    }))
    .min(1),
  documentId: uuid.optional(),
});

export const SalesInvoiceBody = z.object({
  customerId: uuid.optional(),
  customerName: z.string().min(1).max(200).optional(),
  issueDate: isoDate,
  deliveryDate: isoDate.optional(),
  settlement: SettlementSchema,
  lines: z
    .array(z.object({
      description: z.string().min(1).max(300),
      quantity: z.number().positive().optional(),
      netCents: positiveCents,
      vatCode: z.enum(['SR', 'ZR', 'EX', 'OS']),
    }))
    .min(1),
});

export const PaymentBody = z.object({
  kind: z.enum(['receipt', 'payment']),
  contactId: uuid,
  date: isoDate,
  method: PaymentMethodSchema,
  amountCents: positiveCents,
  allocations: z.array(z.object({ invoiceId: uuid, amountCents: positiveCents })).default([]),
});

export const ReasonBody = z.object({ reason: z.string().min(5).max(500) });

/** Ask someone to pay: a sales invoice (customer pays the shop) or a booking deposit (shop pays Nex-Gen). */
export const PaymentRequestBody = z.object({
  payableKind: z.enum(['invoice', 'booking']),
  payableId: uuid,
  amountCents: positiveCents.optional(),
  expiresInDays: z.number().int().min(1).max(90).default(14),
});
/** How this business gets paid. Null clears a field. */
export const PaymentSettingsBody = z.object({
  juiceMobile: z.string().regex(/^\+2305\d{7}$/, 'Mauritian mobile in full, e.g. +23057123456').nullable().optional(),
  juiceName: z.string().max(120).nullable().optional(),
  bankName: z.string().max(120).nullable().optional(),
  bankAccountName: z.string().max(120).nullable().optional(),
  bankAccountNumber: z.string().regex(/^[0-9 -]{6,30}$/, 'Digits only').nullable().optional(),
  bankIban: z.string().regex(/^MU\d{2}[A-Z0-9]{26}$/, 'A Mauritian IBAN has 30 characters and starts with MU').nullable().optional(),
  qrDocumentId: uuid.nullable().optional(),
  cardProvider: z.enum(['mips', 'stripe']).nullable().optional(),
});
/** Public pay page: the payer says they sent the money by Juice or bank transfer. */
export const PayNotifyBody = z.object({
  method: z.enum(['juice', 'bank_transfer']),
  paidOn: isoDate,
  payerName: z.string().max(120).optional(),
  payerReference: z.string().max(60).optional(),
  proofDocumentId: uuid.optional(),
});
export const ProofUploadBody = z.object({
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
  byteSize: z.number().int().positive().max(10 * 1024 * 1024),
});
export const ConfirmIncomingBody = z.object({ receivedOn: isoDate, bankReference: z.string().max(60).optional() });
export const RejectIncomingBody = z.object({ reason: z.string().min(5).max(300) });

export const BookingBody = z.object({ startsAt: z.string().datetime({ offset: true }) });

export const QueryCreateBody = z.object({
  body: z.string().min(1).max(4000),
  transactionId: uuid.optional(),
  documentId: uuid.optional(),
  periodId: uuid.optional(),
  blocking: z.boolean().default(true),
});

export const QueryReplyBody = z
  .object({ body: z.string().min(1).max(4000).optional(), attachmentDocumentId: uuid.optional() })
  .refine((b) => !!b.body || !!b.attachmentDocumentId, 'Write a reply or attach a document');

export const AckBody = z.object({ mraReference: z.string().min(3).max(60), documentId: uuid });
export const PaymentConfirmBody = z.object({
  paymentReference: z.string().min(3).max(60),
  paidOn: isoDate,
  documentId: uuid.optional(),
});

export const ReviewerApproveBody = z.object({
  corrections: z
    .object({
      supplierName: z.string().min(1).max(200).optional(),
      supplierVatNumber: z.string().regex(/^\d{8}$/).optional(),
      invoiceNumber: z.string().min(1).max(60).optional(),
      invoiceDate: isoDate.optional(),
      netCents: cents.optional(),
      vatCents: cents.optional(),
      category: z.enum(categoryKeys).optional(),
    })
    .default({}),
  lateReason: z.string().min(5).max(500).optional(),
  treatExpiredClaimAsCost: z.boolean().default(false),
});

export type CreateOrgInput = z.input<typeof CreateOrgBody>;
export type OpeningBalancesInput = z.input<typeof OpeningBalancesBody>;
export type UploadUrlInput = z.input<typeof UploadUrlBody>;
export type DocumentAnswersInput = z.input<typeof DocumentAnswersBody>;
export type DailyTakingsInput = z.input<typeof DailyTakingsBody>;
export type SalesInvoiceInput = z.input<typeof SalesInvoiceBody>;
export type PaymentInput = z.input<typeof PaymentBody>;
export type PaymentRequestInput = z.input<typeof PaymentRequestBody>;
export type PaymentSettingsInput = z.input<typeof PaymentSettingsBody>;
export type PayNotifyInput = z.input<typeof PayNotifyBody>;
export type QueryCreateInput = z.input<typeof QueryCreateBody>;
export type ReviewerApproveInput = z.input<typeof ReviewerApproveBody>;
