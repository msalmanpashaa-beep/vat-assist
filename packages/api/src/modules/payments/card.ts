import Stripe from 'stripe';
import type { AppConfig } from '../../config';
import { DomainError } from '../../common/errors';
import type { MipsClient } from './mips';

export interface CardCheckoutRequest {
  paymentId: string;
  orgId: string;
  orderRef: string;
  amountCents: number;
  description: string;
  returnUrl: string;
  cancelUrl: string;
}

/** Stripe sends the payer to a hosted page; MIPS gives back an iframe to show on our own pay page. */
export type CardCheckout = { kind: 'redirect'; url: string; providerRef: string } | { kind: 'html'; html: string; providerRef: string };

export interface CardGateway {
  readonly provider: 'stripe' | 'mips';
  createCheckout(r: CardCheckoutRequest): Promise<CardCheckout>;
}

export interface CardGateways {
  stripe: CardGateway;
  mips: CardGateway;
}

export const CARD_GATEWAYS = Symbol('CARD_GATEWAYS');

class StripeCheckout implements CardGateway {
  readonly provider = 'stripe' as const;
  constructor(private readonly stripe: Stripe) {}

  async createCheckout(r: CardCheckoutRequest): Promise<CardCheckout> {
    const s = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        line_items: [{ quantity: 1, price_data: { currency: 'mur', unit_amount: r.amountCents, product_data: { name: r.description } } }],
        success_url: r.returnUrl,
        cancel_url: r.cancelUrl,
        client_reference_id: r.orderRef,
        metadata: { paymentId: r.paymentId, orgId: r.orgId },
        payment_intent_data: { metadata: { paymentId: r.paymentId, orgId: r.orgId } },
      },
      { idempotencyKey: `checkout-${r.paymentId}` },
    );
    if (!s.url) throw new Error('Stripe did not return a checkout URL');
    return { kind: 'redirect', url: s.url, providerRef: s.id };
  }
}

class MockStripeCheckout implements CardGateway {
  readonly provider = 'stripe' as const;
  constructor(private readonly baseUrl: string) {}
  async createCheckout(r: CardCheckoutRequest): Promise<CardCheckout> {
    return { kind: 'redirect', url: `${this.baseUrl}/dev/card/${r.paymentId}`, providerRef: `cs_mock_${r.paymentId}` };
  }
}

class MipsCheckout implements CardGateway {
  readonly provider = 'mips' as const;
  constructor(private readonly mips: MipsClient) {}
  async createCheckout(r: CardCheckoutRequest): Promise<CardCheckout> {
    const html = await this.mips.loadPaymentZone({ idOrder: r.orderRef, amountCents: r.amountCents, returnUrl: r.returnUrl, paymentId: r.paymentId });
    return { kind: 'html', html, providerRef: r.orderRef };
  }
}

class NotConfigured implements CardGateway {
  constructor(readonly provider: 'stripe' | 'mips') {}
  async createCheckout(): Promise<CardCheckout> {
    throw new DomainError('card_unavailable', 'Card payment is not set up yet. Pay by Juice or bank transfer instead.', 503);
  }
}

export function createCardGateways(cfg: AppConfig, mips: MipsClient): CardGateways {
  const live = cfg.env.PAYMENTS_MODE === 'live';
  const stripe = !live
    ? new MockStripeCheckout(cfg.env.PUBLIC_BASE_URL)
    : cfg.env.STRIPE_SECRET_KEY
      ? new StripeCheckout(new Stripe(cfg.env.STRIPE_SECRET_KEY))
      : new NotConfigured('stripe');
  return { stripe, mips: new MipsCheckout(mips) };
}
