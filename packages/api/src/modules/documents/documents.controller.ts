import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { DocumentAnswersBody, ReasonBody, ReviewerApproveBody, UploadUrlBody } from '@vat-assist/shared';
import type { z } from 'zod';
import { CurrentScope, type OrgScope, Roles } from '../../common/auth-context';
import { ZodBody } from '../../common/zod.pipe';
import { OrgGuard } from '../core/guards';
import { DocumentsService } from './documents.service';

const REVIEWERS = ['reviewer', 'senior_reviewer', 'admin'] as const;

@Controller('orgs/:orgId/documents')
@UseGuards(OrgGuard)
export class DocumentsController {
  constructor(private readonly docs: DocumentsService) {}

  @Post('upload-url')
  @Roles('owner', 'staff', ...REVIEWERS)
  uploadUrl(@CurrentScope() s: OrgScope, @Body(new ZodBody(UploadUrlBody)) body: z.output<typeof UploadUrlBody>) {
    return this.docs.createUpload(s, body);
  }

  @Post(':id/complete')
  @Roles('owner', 'staff', ...REVIEWERS)
  complete(@CurrentScope() s: OrgScope, @Param('id') id: string) {
    return this.docs.complete(s, id);
  }

  @Get()
  list(@CurrentScope() s: OrgScope, @Query('status') status?: string) {
    return this.docs.list(s, status);
  }

  @Get(':id')
  get(@CurrentScope() s: OrgScope, @Param('id') id: string) {
    return this.docs.get(s, id);
  }

  @Post(':id/answers')
  @Roles('owner', 'staff', ...REVIEWERS)
  answer(@CurrentScope() s: OrgScope, @Param('id') id: string, @Body(new ZodBody(DocumentAnswersBody)) body: z.output<typeof DocumentAnswersBody>) {
    return this.docs.answer(s, id, body);
  }

  @Post(':id/approve')
  @Roles(...REVIEWERS)
  approve(@CurrentScope() s: OrgScope, @Param('id') id: string, @Body(new ZodBody(ReviewerApproveBody)) body: z.output<typeof ReviewerApproveBody>) {
    return this.docs.approve(s, id, body);
  }

  @Post(':id/archive')
  @Roles(...REVIEWERS)
  archive(@CurrentScope() s: OrgScope, @Param('id') id: string, @Body(new ZodBody(ReasonBody)) body: z.output<typeof ReasonBody>) {
    return this.docs.archive(s, id, body.reason);
  }
}
