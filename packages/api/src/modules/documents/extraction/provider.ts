import type { ExtractedInvoice, ExtractionField } from '@vat-assist/shared';

export interface ExtractionInput {
  bytes: Buffer;
  mimeType: string;
  originalFilename: string | null;
  orgLegalName: string;
  orgVatNumber: string | null;
}

export interface ExtractionProvider {
  readonly name: string;
  extract(input: ExtractionInput): Promise<ExtractedInvoice>;
}

export const field = <T>(value: T | null, confidence: number): ExtractionField<T> => ({ value, confidence });
export const empty = <T>(): ExtractionField<T> => ({ value: null, confidence: 0 });
