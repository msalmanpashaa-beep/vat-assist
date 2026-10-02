import { Controller, Get, UseGuards } from '@nestjs/common';
import { type Actor, CurrentActor, CurrentScope, type OrgScope, Roles } from '../../common/auth-context';
import { OrgGuard } from '../core/guards';
import { ReviewerService } from './reviewer.service';

@Controller('reviewer')
export class ReviewerController {
  constructor(private readonly reviewer: ReviewerService) {}

  /** Every client assigned to the signed-in reviewer, most urgent first. Empty for non-staff users. */
  @Get('portfolio')
  portfolio(@CurrentActor() a: Actor) {
    return this.reviewer.portfolio(a);
  }

  /** Documents across all assigned clients that need a reviewer's decision. */
  @Get('queue')
  queue(@CurrentActor() a: Actor) {
    return this.reviewer.queue(a);
  }

  @Get('orgs/:orgId/file')
  @UseGuards(OrgGuard)
  @Roles('reviewer', 'senior_reviewer', 'admin')
  file(@CurrentScope() s: OrgScope) {
    return this.reviewer.clientFile(s);
  }
}
