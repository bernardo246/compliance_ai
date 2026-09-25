import { Module } from '@nestjs/common';
import { AnalysisController } from './analysis.controller';
import { AnalysisReadService } from './analysis-read.service';
import { BullModule } from '@nestjs/bullmq';
import { AnalysisQueueService, ANALISES_QUEUE } from './analysis-queue.service';
import { AnalysisProcessor } from './analysis.processor';
import { AnalysisService } from './analysis.service';
import { ExtractionService } from './extraction.service';
import { OpenRouterClient } from './openrouter.client';

@Module({
  imports: [BullModule.registerQueue({ name: ANALISES_QUEUE })],
  controllers: [AnalysisController],
  providers: [
    AnalysisService,
    ExtractionService,
    OpenRouterClient,
    AnalysisQueueService,
    AnalysisProcessor,
    AnalysisReadService,
  ],
  // AnalysisQueueService é exportado para o DocumentsModule enfileirar a
  // análise logo após o upload; AnalysisReadService para embutir a análise
  // no detalhe do documento.
  exports: [AnalysisService, ExtractionService, AnalysisQueueService, AnalysisReadService],
})
export class AnalysisModule {}
