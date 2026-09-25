import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AnalysisModule } from '../analysis/analysis.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { RetentionService, RETENCAO_QUEUE } from './retention.service';
import { RetentionProcessor } from './retention.processor';
import { MalwareScanService } from './security/malware-scan.service';

@Module({
  imports: [AnalysisModule, BullModule.registerQueue({ name: RETENCAO_QUEUE })], // Fase 5: enfileirar análise no upload + ler resultado
  controllers: [DocumentsController],
  // RetentionService (Fase 7) mora aqui porque só ela mexe no ciclo de vida
  // do storage_path/deletado_em de `documents` — mesma responsabilidade do
  // DocumentsService, só que disparada por job repetível do BullMQ em vez de por request.
  // MalwareScanService (Fase 8) é usado só pelo upload, mas fica separado
  // do DocumentsService pra ser testável isoladamente.
  providers: [DocumentsService, RetentionService, RetentionProcessor, MalwareScanService],
  exports: [DocumentsService, RetentionService, MalwareScanService],
})
export class DocumentsModule {}
