/**
 * What the owner answers to "What is it for?". Each category maps to an account and a VAT treatment.
 * Blocked items follow s.21(2) VAT Act (cars and their running costs, accommodation/catering/entertainment).
 * Foreign services always go to a reviewer: s.14 reverse charge for ordinary services; input tax on
 * digital/electronic services is blocked — the reviewer confirms which applies.
 */
export type VatTreatment = 'claimable' | 'blocked' | 'none' | 'reverse_charge' | 'reverse_charge_blocked';

export interface PurchaseCategory {
  accountTag: string;
  vat: VatTreatment;
  alwaysReview: boolean;
}

export const PURCHASE_CATEGORIES = {
  stock_for_resale: { accountTag: 'purchases', vat: 'claimable', alwaysReview: false },
  shop_expense: { accountTag: 'general_expense', vat: 'claimable', alwaysReview: false },
  rent: { accountTag: 'rent', vat: 'claimable', alwaysReview: false },
  utilities: { accountTag: 'utilities', vat: 'claimable', alwaysReview: false },
  transport: { accountTag: 'transport', vat: 'claimable', alwaysReview: false },
  telecom: { accountTag: 'telecom', vat: 'claimable', alwaysReview: false },
  repairs: { accountTag: 'repairs', vat: 'claimable', alwaysReview: false },
  equipment: { accountTag: 'equipment', vat: 'claimable', alwaysReview: false },
  vehicle_car: { accountTag: 'motor_expenses', vat: 'blocked', alwaysReview: false },
  meals_entertainment: { accountTag: 'entertainment', vat: 'blocked', alwaysReview: false },
  personal: { accountTag: 'drawings', vat: 'none', alwaysReview: false },
  foreign_service: { accountTag: 'general_expense', vat: 'reverse_charge', alwaysReview: true },
  foreign_digital_service: { accountTag: 'general_expense', vat: 'reverse_charge_blocked', alwaysReview: true },
} as const satisfies Record<string, PurchaseCategory>;

export type PurchaseCategoryKey = keyof typeof PURCHASE_CATEGORIES;
export const PURCHASE_CATEGORY_KEYS = Object.keys(PURCHASE_CATEGORIES) as PurchaseCategoryKey[];


/** What the owner sees for each category. Kreol strings need a native speaker's check before launch. */
export const CATEGORY_LABELS: Record<'en' | 'fr' | 'mfe', Record<keyof typeof PURCHASE_CATEGORIES, string>> = {
  en: {
    stock_for_resale: 'Stock to resell', shop_expense: 'Shop supplies and expenses', rent: 'Rent', utilities: 'Electricity and water',
    transport: 'Transport and delivery', telecom: 'Phone and internet', repairs: 'Repairs and maintenance',
    equipment: 'Equipment (fridge, till, shelves)', vehicle_car: 'Car and fuel', meals_entertainment: 'Meals and entertaining',
    personal: 'Personal, not for the business', foreign_service: 'Service from abroad', foreign_digital_service: 'App or online service from abroad',
  },
  fr: {
    stock_for_resale: 'Marchandises à revendre', shop_expense: 'Fournitures et frais du magasin', rent: 'Loyer', utilities: 'Électricité et eau',
    transport: 'Transport et livraison', telecom: 'Téléphone et internet', repairs: 'Réparations et entretien',
    equipment: 'Équipement (frigo, caisse, étagères)', vehicle_car: 'Voiture et carburant', meals_entertainment: 'Repas et réceptions',
    personal: 'Personnel, pas pour le commerce', foreign_service: "Service venant de l'étranger", foreign_digital_service: "Application ou service en ligne de l'étranger",
  },
  mfe: {
    stock_for_resale: 'Marsandiz pou revann', shop_expense: 'Fourniti ek depans laboutik', rent: 'Lwaye', utilities: 'Elektrisite ek dilo',
    transport: 'Transpor ek livrezon', telecom: 'Telefonn ek internet', repairs: 'Reparasion ek lantretien',
    equipment: 'Lekipman (frizider, lakes, etazer)', vehicle_car: 'Loto ek lesans', meals_entertainment: 'Manze ek resepsion',
    personal: 'Personel, pa pou biznes', foreign_service: 'Servis depi letranze', foreign_digital_service: 'Aplikasion ouswa servis lor internet depi letranze',
  },
};
