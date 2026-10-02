import { AcceptInviteBody } from '@vat-assist/shared';
import { Body, Controller, Get, Headers, HttpCode, Patch, Post, Req } from '@nestjs/common';
import { LocaleSchema, RefreshBody, StaffLoginBody, StartOtpBody, TotpCodeBody, VerifyOtpBody } from '@vat-assist/shared';
import type { Request } from 'express';
import { z } from 'zod';
import { type Actor, CurrentActor, Public } from '../../common/auth-context';
import { DomainError } from '../../common/errors';
import { ZodBody } from '../../common/zod.pipe';
import { AuthService, type RequestMeta } from './auth.service';

const meta = (req: Request): RequestMeta => ({ ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null });
const bearer = (h?: string) => {
  if (!h?.startsWith('Bearer ')) throw new DomainError('unauthenticated', 'Sign in with your email and password first.', 401);
  return h.slice(7);
};
const MeUpdate = z.object({ locale: LocaleSchema.optional(), fullName: z.string().min(1).max(120).optional(), whatsappOptIn: z.boolean().optional() });

@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('auth/otp/start')
  @HttpCode(202)
  async startOtp(@Body(new ZodBody(StartOtpBody)) body: z.output<typeof StartOtpBody>, @Req() req: Request) {
    await this.auth.startOtp(body.phone, meta(req));
    return { sent: true };
  }

  @Public()
  @Post('auth/otp/verify')
  @HttpCode(200)
  verifyOtp(@Body(new ZodBody(VerifyOtpBody)) body: z.output<typeof VerifyOtpBody>, @Req() req: Request) {
    return this.auth.verifyOtp(body.phone, body.code, body.locale, meta(req));
  }

  @Public()
  @Post('auth/staff/login')
  @HttpCode(200)
  staffLogin(@Body(new ZodBody(StaffLoginBody)) body: z.output<typeof StaffLoginBody>, @Req() req: Request) {
    return this.auth.staffLogin(body.email, body.password, meta(req));
  }

  @Public()
  @Post('auth/staff/totp/setup')
  @HttpCode(200)
  totpSetup(@Headers('authorization') h?: string) {
    return this.auth.totpSetup(bearer(h));
  }

  @Public()
  @Post('auth/staff/totp/verify')
  @HttpCode(200)
  totpVerify(@Body(new ZodBody(TotpCodeBody)) body: z.output<typeof TotpCodeBody>, @Req() req: Request, @Headers('authorization') h?: string) {
    return this.auth.totpVerify(bearer(h), body.code, meta(req));
  }

  @Public()
  @Post('auth/refresh')
  @HttpCode(200)
  refresh(@Body(new ZodBody(RefreshBody)) body: z.output<typeof RefreshBody>, @Req() req: Request) {
    return this.auth.refresh(body.refreshToken, meta(req));
  }

  @Post('auth/logout')
  @HttpCode(204)
  async logout(@CurrentActor() a: Actor) {
    await this.auth.logout(a.sessionId);
  }

  @Get('me')
  me(@CurrentActor() a: Actor) {
    return this.auth.me(a.userId);
  }

  @Patch('me')
  async updateMe(@CurrentActor() a: Actor, @Body(new ZodBody(MeUpdate)) body: z.output<typeof MeUpdate>) {
    await this.auth.updateMe(a.userId, body);
    return this.auth.me(a.userId);
  }

  @Public()
  @Post('auth/staff/invite/accept')
  @HttpCode(200)
  acceptInvite(@Body(new ZodBody(AcceptInviteBody)) body: z.output<typeof AcceptInviteBody>) {
    return this.auth.acceptInvite(body.token, body.password);
  }
}
