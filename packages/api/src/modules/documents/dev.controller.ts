import { Body, Controller, Get, HttpCode, NotFoundException, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { AppConfig } from '../../config';
import { Public } from '../../common/auth-context';
import { DomainError } from '../../common/errors';
import { StorageService } from '../core/storage.service';

/**
 * Development stand-ins for S3 presigned uploads/downloads .
 * Disabled unless STORAGE_DRIVER=local and NODE_ENV is not production.
 */
/** The part of a multer upload we use (avoids depending on global Express.Multer types). */
interface UploadedBlob {
  buffer: Buffer;
  size: number;
  mimetype: string;
  originalname: string;
}

@Controller('dev')
export class DevController {
  constructor(
    private readonly cfg: AppConfig,
    private readonly storage: StorageService,
  ) {}

  private guard(): void {
    if (this.cfg.isProduction || this.cfg.env.STORAGE_DRIVER !== 'local') throw new NotFoundException();
  }

  @Public()
  @Post('uploads')
  @HttpCode(204)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 20 * 1024 * 1024 } }))
  async upload(@Body() fields: Record<string, string>, @UploadedFile() file?: UploadedBlob): Promise<void> {
    this.guard();
    if (!file) throw new DomainError('no_file', 'No file received.', 400);
    if (!this.storage.verifyLocalUpload(fields)) throw new DomainError('bad_signature', 'Upload link expired or invalid.', 403);
    if (file.size > Number(fields.maxBytes)) throw new DomainError('too_large', 'File larger than allowed.', 413);
    await this.storage.put(fields.key as string, file.buffer, fields['Content-Type'] ?? file.mimetype);
  }

  @Public()
  @Get('files')
  async file(@Query('key') key: string, @Query('expires') expires: string, @Query('signature') sig: string, @Res() res: Response): Promise<void> {
    this.guard();
    if (!this.storage.verifyLocalDownload(key, Number(expires), sig)) throw new DomainError('bad_signature', 'Link expired.', 403);
    res.send(await this.storage.get(key));
  }
}
