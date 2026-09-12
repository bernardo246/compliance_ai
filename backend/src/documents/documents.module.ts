import { Module } from '@nestjs/common';
import { AnalysisModule } from '../analysis/analysis.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { RetentionService } from './retention.service';

@Module({
  imports: [AnalysisModule], // Fase 5: enfileirar análise no upload + ler resultado
  controllers: [DocumentsController],
  // RetentionService (Fase 7) mora aqui porque só ela mexe no ciclo de vida
  // do storage_path/deletado_em de `documents` — mesma responsabilidade do
  // DocumentsService, só que disparada pelo cron em vez de por request.
  providers: [DocumentsService, RetentionService],
  exports: [DocumentsService, RetentionService],
})
export class DocumentsModule {}
