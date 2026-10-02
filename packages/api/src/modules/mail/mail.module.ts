import { Global, Module } from '@nestjs/common';
import { AppConfig } from '../../config';
import { DevMailController } from './dev-mail.controller';
import { createMailProvider, MAIL_PROVIDER } from './mail';

@Global()
@Module({
  controllers: [DevMailController],
  providers: [{ provide: MAIL_PROVIDER, inject: [AppConfig], useFactory: (cfg: AppConfig) => createMailProvider(cfg) }],
  exports: [MAIL_PROVIDER],
})
export class MailModule {}
