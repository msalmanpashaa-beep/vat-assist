import type { Locale } from './money';

/**
 * What the owner agrees to before VAT Assist uses WhatsApp. The version is stored with the opt-in, so a
 * change of wording can be traced. Kreol and French need a native speaker's check before launch.
 */
export const WHATSAPP_CONSENT = {
  version: '2026-10-v1',
  text: {
    en: 'VAT Assist may send you VAT deadline reminders, booking reminders and messages about payments on WhatsApp instead of SMS, at most a few times a month. Messages go through Twilio and Meta (WhatsApp). Reply STOP at any time, or switch this off in Settings.',
    fr: "VAT Assist peut vous envoyer sur WhatsApp, au lieu du SMS, les rappels d'échéance de TVA, de rendez-vous et les messages sur les paiements, quelques fois par mois au plus. Les messages passent par Twilio et Meta (WhatsApp). Répondez STOP à tout moment, ou désactivez-le dans Paramètres.",
    mfe: 'VAT Assist kapav avoy ou rapel pou dat VAT, rapel randevou ek mesaz lor peyman lor WhatsApp olie SMS, pa plis ki detrwa fwa par mwa. Mesaz pas par Twilio ek Meta (WhatsApp). Reponn STOP nimport kan, ouswa tengn li dan Paramet.',
  } satisfies Record<Locale, string>,
};
