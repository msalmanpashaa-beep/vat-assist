import type { Locale } from './money';
import { interpolate } from './i18n';

/**
 * Outbound reminder texts. SMS uses these strings directly. WhatsApp business-initiated messages must use
 * Meta-approved templates: register each one in Twilio Content Template Builder with the SAME variables,
 * in the same order, and put the resulting Content SIDs in TWILIO_WHATSAPP_CONTENT_SIDS.
 */
export const TEMPLATE_VARIABLES = {
  vat_due_tomorrow: ['business', 'period', 'date', 'amount'],
  booking_tomorrow: ['date', 'time'],
  invoice_due_tomorrow: ['business', 'number', 'amount', 'date'],
  payment_claimed: ['payer', 'amount', 'method', 'reference'],
} as const;

export type TemplateKey = keyof typeof TEMPLATE_VARIABLES;

export const TEMPLATES: Record<TemplateKey, Record<Locale, string>> = {
  vat_due_tomorrow: {
    en: 'VAT Assist: tomorrow ({{date}}) is the last day for the {{period}} VAT return of {{business}}. Amount to set aside: {{amount}}.',
    fr: 'VAT Assist : demain ({{date}}) est le dernier jour pour la déclaration de TVA {{period}} de {{business}}. Montant à mettre de côté : {{amount}}.',
    mfe: 'VAT Assist: Demin ({{date}}) dernie zour pou deklarasion VAT {{period}} {{business}}. Montan pou met de kote: {{amount}}.',
  },
  booking_tomorrow: {
    en: 'VAT Assist: reminder, your call with Nex-Gen is tomorrow, {{date}} at {{time}}.',
    fr: 'VAT Assist : rappel, votre appel avec Nex-Gen est demain, le {{date}} à {{time}}.',
    mfe: 'VAT Assist: Rapel, ou randevou ar Nex-Gen se demin, {{date}} a {{time}}.',
  },
  invoice_due_tomorrow: {
    en: '{{business}}: invoice {{number}} for {{amount}} is due tomorrow ({{date}}). Thank you.',
    fr: '{{business}} : la facture {{number}} de {{amount}} arrive à échéance demain ({{date}}). Merci.',
    mfe: '{{business}}: fakti {{number}} pou {{amount}} bizin peye demin ({{date}}). Mersi.',
  },
  payment_claimed: {
    en: 'VAT Assist: {{payer}} says they paid {{amount}} by {{method}} (ref {{reference}}). Check your account, then confirm or reject it in the app.',
    fr: "VAT Assist : {{payer}} indique avoir payé {{amount}} par {{method}} (réf. {{reference}}). Vérifiez votre compte, puis confirmez ou refusez dans l'application.",
    mfe: 'VAT Assist: {{payer}} dir li finn pey {{amount}} par {{method}} (ref {{reference}}). Get ou kont, apre konfirme ouswa refiz li dan aplikasion.',
  },
};

export function renderTemplate(key: TemplateKey, locale: Locale, vars: Record<string, string>): string {
  for (const v of TEMPLATE_VARIABLES[key]) {
    if (!(v in vars)) throw new Error(`Template ${key} needs variable "${v}"`);
  }
  return interpolate(TEMPLATES[key][locale] ?? TEMPLATES[key].en, vars);
}

/** WhatsApp Content API wants positional variables {"1": "...", "2": "..."} in template order. */
export function positionalVariables(key: TemplateKey, vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  TEMPLATE_VARIABLES[key].forEach((name, i) => {
    out[String(i + 1)] = vars[name] ?? '';
  });
  return out;
}
