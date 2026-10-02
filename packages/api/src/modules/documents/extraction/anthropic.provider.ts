import Anthropic from '@anthropic-ai/sdk';
import { type ExtractedInvoice, type IsoDate, rupeesToCents, type VatCode } from '@vat-assist/shared';
import sharp from 'sharp';
import { z } from 'zod';
import type { ExtractionInput, ExtractionProvider } from './provider';

const SYSTEM = `You read photos and PDFs of invoices and receipts received by small businesses in Mauritius.
Report exactly what is printed. Never guess a value that is not visible: use null and a low confidence.
Mauritius context: standard VAT is 15%. A VAT registration number is the 8-digit Tax Account Number (TAN).
A valid VAT invoice shows the words "VAT INVOICE". Amounts are in Mauritian rupees (Rs / MUR) unless another
currency is printed. Dates may be written DD/MM/YYYY: return them as YYYY-MM-DD.
Confidence is your probability (0 to 1) that the value is exactly right.`;

const f = (type: 'string' | 'number') => ({
  type: 'object' as const,
  properties: { value: { type: [type, 'null'] }, confidence: { type: 'number', minimum: 0, maximum: 1 } },
  required: ['value', 'confidence'],
});

const TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    document_type: { type: 'string', enum: ['vat_invoice', 'invoice', 'receipt', 'till_report', 'statement', 'mra_letter', 'other'] },
    has_vat_invoice_words: { type: ['boolean', 'null'] },
    supplier_name: f('string'),
    supplier_vat_number: f('string'),
    supplier_brn: f('string'),
    buyer_name: f('string'),
    buyer_vat_number: f('string'),
    invoice_number: f('string'),
    invoice_date: f('string'),
    currency: f('string'),
    amount_before_vat_rupees: f('number'),
    vat_rupees: f('number'),
    total_rupees: f('number'),
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          amount_rupees: { type: ['number', 'null'] },
          vat_rate_percent: { type: ['number', 'null'] },
        },
        required: ['description'],
      },
    },
  },
  required: ['document_type', 'supplier_name', 'invoice_number', 'invoice_date', 'total_rupees', 'vat_rupees', 'amount_before_vat_rupees'],
};

const F = <T extends z.ZodType>(t: T) => z.object({ value: t.nullable(), confidence: z.number().min(0).max(1) });
const Raw = z.object({
  document_type: z.enum(['vat_invoice', 'invoice', 'receipt', 'till_report', 'statement', 'mra_letter', 'other']),
  has_vat_invoice_words: z.boolean().nullable().optional(),
  supplier_name: F(z.string()),
  supplier_vat_number: F(z.string()).optional(),
  supplier_brn: F(z.string()).optional(),
  buyer_name: F(z.string()).optional(),
  buyer_vat_number: F(z.string()).optional(),
  invoice_number: F(z.string()),
  invoice_date: F(z.string()),
  currency: F(z.string()).optional(),
  amount_before_vat_rupees: F(z.number()),
  vat_rupees: F(z.number()),
  total_rupees: F(z.number()),
  lines: z.array(z.object({ description: z.string(), amount_rupees: z.number().nullable().optional(), vat_rate_percent: z.number().nullable().optional() })).optional(),
});

const none = { value: null, confidence: 0 };
const money = (v: { value: number | null; confidence: number }) => ({ value: v.value == null ? null : rupeesToCents(v.value), confidence: v.confidence });
const isoDate = (v: { value: string | null; confidence: number }) =>
  v.value && /^\d{4}-\d{2}-\d{2}$/.test(v.value) ? { value: v.value as IsoDate, confidence: v.confidence } : { value: null, confidence: 0 };

/**
 * Claude reads the document and must answer through the record_invoice tool, so the output always has the
 * same shape; zod then validates it. Images are downscaled first (size and cost). Model is configurable.
 */
export class AnthropicExtractionProvider implements ExtractionProvider {
  readonly name: string;
  private readonly client: Anthropic;

  constructor(apiKey: string, private readonly model: string) {
    this.client = new Anthropic({ apiKey });
    this.name = `anthropic:${model}`;
  }

  async extract(input: ExtractionInput): Promise<ExtractedInvoice> {
    const isPdf = input.mimeType === 'application/pdf';
    const bytes = isPdf
      ? input.bytes
      : await sharp(input.bytes).rotate().resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    const data = bytes.toString('base64');
    const media = isPdf
      ? ({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } } as const)
      : ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } } as const);
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 2000,
      system: SYSTEM,
      tools: [{ name: 'record_invoice', description: 'Record the fields printed on this document.', input_schema: TOOL_SCHEMA }],
      tool_choice: { type: 'tool', name: 'record_invoice' },
      messages: [{
        role: 'user',
        content: [media, { type: 'text', text: `The business that received this document: ${input.orgLegalName}${input.orgVatNumber ? `, VAT number ${input.orgVatNumber}` : ''}.` }],
      }],
    });
    const block = res.content.find((b) => b.type === 'tool_use');
    if (!block || block.type !== 'tool_use') throw new Error('Extraction returned no structured result');
    const r = Raw.parse(block.input);
    return {
      documentType: r.document_type,
      hasVatInvoiceWords: r.has_vat_invoice_words ?? null,
      supplierName: r.supplier_name,
      supplierVatNumber: r.supplier_vat_number ?? none,
      supplierBrn: r.supplier_brn ?? none,
      buyerName: r.buyer_name ?? none,
      buyerVatNumber: r.buyer_vat_number ?? none,
      invoiceNumber: r.invoice_number,
      invoiceDate: isoDate(r.invoice_date),
      currency: r.currency ?? { value: 'MUR', confidence: 0.5 },
      netCents: money(r.amount_before_vat_rupees),
      vatCents: money(r.vat_rupees),
      totalCents: money(r.total_rupees),
      lines: (r.lines ?? []).map((l) => ({
        description: l.description,
        amountCents: l.amount_rupees == null ? null : rupeesToCents(l.amount_rupees),
        vatCode: (l.vat_rate_percent === 15 ? 'SR' : l.vat_rate_percent === 0 ? 'ZR' : null) as VatCode | null,
      })),
    };
  }
}
