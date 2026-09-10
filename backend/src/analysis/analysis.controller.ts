import { Controller, Get, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { AuthenticatedUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { TermsAcceptedGuard } from '../common/guards/terms-accepted.guard';
import { AnalysisReadService } from './analysis-read.service';

@Controller('api/analyses')
@UseGuards(TermsAcceptedGuard)
export class AnalysisController {
  constructor(private readonly analysisRead: AnalysisReadService) {}

  /** GET /api/analyses/:id — resultado da análise + sugestões (spec seção 7). */
  @Get(':id')
  getOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    return this.analysisRead.findByIdForUser(user.id, id);
  }
}
