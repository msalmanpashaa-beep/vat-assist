import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { AppConfig } from './config';

async function bootstrap(): Promise<void> {
  // rawBody: Stripe signs the exact bytes it sent, so the webhook needs the unparsed body.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true, logger: ['log', 'warn', 'error'] });
  const cfg = app.get(AppConfig);
  // MIPS IMN callbacks may arrive as text/plain.
  app.useBodyParser('text');
  app.set('trust proxy', cfg.env.TRUST_PROXY_HOPS);
  app.enableCors({ origin: [cfg.env.WEB_BASE_URL], credentials: true });
  app.enableShutdownHooks();
  await app.listen(cfg.env.PORT);
  new Logger('VAT Assist').log(`API listening on ${cfg.env.PUBLIC_BASE_URL} (${cfg.env.NODE_ENV})`);
}

void bootstrap();
