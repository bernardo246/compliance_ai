import { Module } from '@nestjs/common';
import { AnalysisController } from './analysis.controller';
import { AnalysisReadService } from './analysis-read.service';
import { AnalysisRunnerService } from './analysis-runner.service';
import { AnalysisService } from './analysis.service';
import { ExtractionService } from './extraction.service';
import { OpenRouterClient } from './openrouter.client';

@Module({
  controllers: [AnalysisController],
  providers: [
    AnalysisService,
    ExtractionService,
    OpenRouterClient,
    AnalysisRunnerService,
    AnalysisReadService,
  ],
  // AnalysisRunnerService é exportado para o DocumentsModule enfileirar a
  // análise logo após o upload; AnalysisReadService para embutir a análise
  // no detalhe do documento.
  exports: [AnalysisService, ExtractionService, AnalysisRunnerService, AnalysisReadService],
})
export class AnalysisModule {}
