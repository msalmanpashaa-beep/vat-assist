import type { ExtractedInvoice } from '@vat-assist/shared';
import { empty, type ExtractionInput, type ExtractionProvider, field } from './provider';

type Fixture = Omit<ExtractedInvoice, 'lines'> & { lines?: ExtractedInvoice['lines'] };

const inv = (
  supplier: string, vatNo: string | null, buyer: string, number: string, date: string,
  net: number, vat: number, conf = 0.97, vatWords = true,
): Fixture => ({
  documentType: vatWords ? 'vat_invoice' : 'invoice',
  hasVatInvoiceWords: vatWords,
  supplierName: field(supplier, conf),
  supplierVatNumber: vatNo ? field(vatNo, conf) : empty(),
  supplierBrn: empty(),
  buyerName: field(buyer, conf),
  buyerVatNumber: empty(),
  invoiceNumber: field(number, conf),
  invoiceDate: field(date, conf),
  currency: field('MUR', 0.99),
  netCents: field(net, conf),
  vatCents: field(vat, conf),
  totalCents: field(net + vat, conf),
});

/** Deterministic results for development and the demo, keyed by uploaded file name. All parties are fictional. */
export const MOCK_FIXTURES: Record<string, Fixture> = {
  'demo-grossiste-INV-0457.jpg': inv('Grossiste Demo Ltd', '27999902', 'Boutik Demo Ltd', 'INV-0457', '2026-08-03', 400_000, 60_000, 0.97),
  'demo-power-BILL-88231.jpg': inv('Island Power Demo Ltd', '27999903', 'Boutik Demo Ltd', 'BILL-88231', '2026-08-28', 260_000, 39_000, 0.96),
  'demo-handwritten-0012.jpg': inv('Ti Kanal Hardware', null, 'Boutique Demo', '0012', '2026-09-10', 100_000, 15_000, 0.71, false),
  'demo-late-grossiste-INV-0502.jpg': inv('Grossiste Demo Ltd', '27999902', 'Boutik Demo Ltd', 'INV-0502', '2026-09-25', 200_000, 30_000, 0.97),
};

export class MockExtractionProvider implements ExtractionProvider {
  readonly name = 'mock';

  async extract(input: ExtractionInput): Promise<ExtractedInvoice> {
    const fx = input.originalFilename ? MOCK_FIXTURES[input.originalFilename] : undefined;
    if (fx) return { ...fx, lines: fx.lines ?? [] };
    // Unknown file: a low-confidence read that will go to a reviewer.
    return {
      documentType: 'invoice', hasVatInvoiceWords: null,
      supplierName: field('Unknown supplier', 0.3), supplierVatNumber: empty(), supplierBrn: empty(),
      buyerName: empty(), buyerVatNumber: empty(), invoiceNumber: empty(), invoiceDate: empty(),
      currency: field('MUR', 0.5), netCents: empty(), vatCents: empty(), totalCents: empty(), lines: [],
    };
  }
}
