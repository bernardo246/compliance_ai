import { Module } from '@nestjs/common';
import { AnalysisModule } from '../analysis/analysis.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';

@Module({
  imports: [AnalysisModule], // Fase 5: enfileirar análise no upload + ler resultado
  controllers: [DocumentsController],
  providers: [DocumentsService],
  exports: [DocumentsService],
})
export class DocumentsModule {}
