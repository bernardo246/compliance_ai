import { Module } from '@nestjs/common';
import { AnalysisService } from './analysis.service';
import { ExtractionService } from './extraction.service';
import { OpenRouterClient } from './openrouter.client';

@Module({
  providers: [AnalysisService, ExtractionService, OpenRouterClient],
  exports: [AnalysisService, ExtractionService],
})
export class AnalysisModule {}
