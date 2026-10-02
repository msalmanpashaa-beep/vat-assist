import { Body, Controller, Get, Header, Headers, HttpCode, Param, Post, Put, Query, type RawBodyRequest, Req, UseGuards } from '@nestjs/common';
import {
  BookingBody, ConfirmIncomingBody, PaymentRequestBody, PaymentSettingsBody, PayNotifyBody, ProofUploadBody, RejectIncomingBody,
} from '@vat-assist/shared';
import type { Request } from 'express';
import type { z } from 'zod';
import { CurrentScope, type OrgScope, Public, Roles } from '../../common/auth-context';
import { ZodBody } from '../../common/zod.pipe';
import { OrgGuard } from '../core/guards';
import { PaymentsService } from './payments.service';

const PAYEES = ['owner', 'reviewer', 'senior_reviewer', 'admin'] as const;
const ip = (req: Request) => req.ip ?? 'unknown';

@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  // ----- the business being paid -----

  @Get('orgs/:orgId/payment-settings')
  @UseGuards(OrgGuard)
  settings(@CurrentScope() s: OrgScope) {
    return this.payments.getSettings(s);
  }

  @Put('orgs/:orgId/payment-settings')
  @UseGuards(OrgGuard)
  @Roles(...PAYEES)
  putSettings(@CurrentScope() s: OrgScope, @Body(new ZodBody(PaymentSettingsBody)) body: z.output<typeof PaymentSettingsBody>) {
    return this.payments.putSettings(s, body);
  }

  /** A pay link for a sales invoice or a booking deposit: card, Juice or bank transfer. */
  @Post('orgs/:orgId/payment-requests')
  @UseGuards(OrgGuard)
  @Roles('owner', 'staff', 'reviewer', 'senior_reviewer', 'admin')
  request(@CurrentScope() s: OrgScope, @Body(new ZodBody(PaymentRequestBody)) body: z.output<typeof PaymentRequestBody>) {
    return this.payments.createRequest(s, body);
  }

  @Get('orgs/:orgId/payment-requests')
  @UseGuards(OrgGuard)
  requests(@CurrentScope() s: OrgScope) {
    return this.payments.listRequests(s);
  }

  @Get('orgs/:orgId/incoming-payments')
  @UseGuards(OrgGuard)
  incoming(@CurrentScope() s: OrgScope, @Query('status') status?: string) {
    return this.payments.incoming(s, status);
  }

  @Post('orgs/:orgId/incoming-payments/:paymentId/confirm')
  @UseGuards(OrgGuard)
  @Roles(...PAYEES)
  @HttpCode(200)
  confirm(@CurrentScope() s: OrgScope, @Param('paymentId') id: string, @Body(new ZodBody(ConfirmIncomingBody)) body: z.output<typeof ConfirmIncomingBody>) {
    return this.payments.confirm(s, id, body);
  }

  @Post('orgs/:orgId/incoming-payments/:paymentId/reject')
  @UseGuards(OrgGuard)
  @Roles(...PAYEES)
  @HttpCode(200)
  reject(@CurrentScope() s: OrgScope, @Param('paymentId') id: string, @Body(new ZodBody(RejectIncomingBody)) body: z.output<typeof RejectIncomingBody>) {
    return this.payments.reject(s, id, body.reason);
  }

  @Post('orgs/:orgId/bookings')
  @UseGuards(OrgGuard)
  @Roles('owner')
  book(@CurrentScope() s: OrgScope, @Body(new ZodBody(BookingBody)) body: z.output<typeof BookingBody>) {
    return this.payments.createBooking(s, body.startsAt);
  }

  @Get('orgs/:orgId/bookings')
  @UseGuards(OrgGuard)
  bookings(@CurrentScope() s: OrgScope) {
    return this.payments.bookings(s);
  }

  // ----- the public pay link (no sign-in; the unguessable token is the key) -----

  @Public()
  @Get('pay/:token')
  view(@Param('token') token: string, @Req() req: Request) {
    return this.payments.publicView(token, ip(req));
  }

  @Public()
  @Post('pay/:token/card')
  @HttpCode(200)
  card(@Param('token') token: string, @Req() req: Request) {
    return this.payments.startCard(token, ip(req));
  }

  @Public()
  @Post('pay/:token/proof-upload')
  proof(@Param('token') token: string, @Body(new ZodBody(ProofUploadBody)) body: z.output<typeof ProofUploadBody>, @Req() req: Request) {
    return this.payments.proofUpload(token, body, ip(req));
  }

  @Public()
  @Post('pay/:token/notify')
  notify(@Param('token') token: string, @Body(new ZodBody(PayNotifyBody)) body: z.output<typeof PayNotifyBody>, @Req() req: Request) {
    return this.payments.notifyPaid(token, body, ip(req));
  }

  // ----- provider callbacks -----

  @Public()
  @Post('webhooks/stripe')
  @HttpCode(200)
  stripe(@Req() req: RawBodyRequest<Request>, @Headers('stripe-signature') signature?: string) {
    return this.payments.handleStripeWebhook(req.rawBody, signature);
  }

  @Public()
  @Post('webhooks/mips')
  @HttpCode(200)
  mips(@Req() req: RawBodyRequest<Request>) {
    return this.payments.handleMipsImn(req.body, req.rawBody, undefined);
  }

  @Public()
  @Post('webhooks/mips/:secret')
  @HttpCode(200)
  mipsWithSecret(@Req() req: RawBodyRequest<Request>, @Param('secret') secret: string) {
    return this.payments.handleMipsImn(req.body, req.rawBody, secret);
  }

  // ----- development only (404 unless PAYMENTS_MODE=mock outside production) -----

  @Public()
  @Get('dev/card/:paymentId')
  @Header('Content-Type', 'text/html; charset=utf-8')
  devCardPage(@Param('paymentId') id: string) {
    const safe = id.replace(/[^\w-]/g, '');
    return `<!doctype html><meta name="viewport" content="width=device-width"><title>Test card payment</title>
<body style="font-family:system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem"><h1>Test card payment</h1>
<p>No card is charged in development.</p><form method="post" action="/dev/card/${safe}/pay"><button>Pay with a test card</button></form></body>`;
  }

  @Public()
  @Post('dev/card/:paymentId/pay')
  @HttpCode(200)
  devPay(@Param('paymentId') id: string) {
    return this.payments.simulateCardSuccess(id);
  }
}
