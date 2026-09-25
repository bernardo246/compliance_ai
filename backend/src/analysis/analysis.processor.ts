import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { SupabaseService } from '../common/supabase/supabase.service';
import { AreaNegocio } from '../documents/dto/upload-document.dto';
import { TipoDocumento } from '../documents/documents.types';
import { AnalysisService } from './analysis.service';
import { ANALISES_QUEUE, AnalisarJobData } from './analysis-queue.service';

interface PendingDocument {
  id: string;
  tipo: TipoDocumento;
  area_negocio: AreaNegocio;
  storage_path: string | null;
  status: string;
  deletado_em: string | null;
}

/**
 * Fase 4 — worker da fila de análise. Cada réplica do backend roda um; o
 * Redis entrega cada job a exatamente um deles.
 *
 * Concorrência fixa em 2 (por réplica): o decorator é avaliado antes do
 * ConfigModule carregar o .env, então não dá pra ler de config aqui.
 * Erros de análise são gravados em documents.status='error' (sem rethrow),
 * igual ao comportamento anterior — o OpenRouterClient já faz retry.
 */
@Processor(ANALISES_QUEUE, { concurrency: 2 })
export class AnalysisProcessor extends WorkerHost {
  private readonly logger = new Logger(AnalysisProcessor.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
    private readonly analysisService: AnalysisService,
  ) {
    super();
  }

  private db() {
    return this.supabase.getClient();
  }

  async process(job: Job<AnalisarJobData>): Promise<void> {
    await this.run(job.data.documentId);
  }

  private async run(documentId: string): Promise<void> {
    const doc = await this.loadDocument(documentId);
    if (!doc) return;

    await this.setStatus(documentId, 'processing', {
      processing_started_at: new Date().toISOString(),
      erro: null,
    });

    try {
      const buffer = await this.downloadFromStorage(doc.storage_path!);
      const outcome = await this.analysisService.analyze(
        buffer,
        doc.tipo,
        doc.area_negocio,
      );

      const { error: upsertError } = await this.db()
        .from('analyses')
        .upsert(
          {
            document_id: documentId,
            resumo_executivo: outcome.result.resumo_executivo,
            status_compliance_geral: outcome.result.status_compliance_geral,
            checklist: outcome.result.checklist,
            dados_faltantes: outcome.result.dados_faltantes,
            sugestoes_melhoria: outcome.result.sugestoes_melhoria,
            aviso_legal: outcome.result.aviso_legal,
            template_versao: outcome.templateVersao,
            modelo_usado: outcome.modelo,
            tokens_usados: outcome.tokensUsados,
            raw_response: { raw: outcome.rawResponse },
          },
          { onConflict: 'document_id' },
        );

      if (upsertError) {
        throw new Error(`Falha ao gravar a análise: ${upsertError.message}`);
      }

      await this.setStatus(documentId, 'done', { erro: null });
      this.logger.log(
        `Análise do documento ${documentId} concluída (${outcome.tokensUsados ?? '?'} tokens).`,
      );
    } catch (err) {
      const mensagem = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Análise do documento ${documentId} falhou: ${mensagem}`);
      await this.setStatus(documentId, 'error', { erro: mensagem.slice(0, 500) });
    }
  }

  private async loadDocument(documentId: string): Promise<PendingDocument | null> {
    const { data, error } = await this.db()
      .from('documents')
      .select('id, tipo, area_negocio, storage_path, status, deletado_em')
      .eq('id', documentId)
      .maybeSingle<PendingDocument>();

    if (error || !data) {
      this.logger.warn(
        `Documento ${documentId} não encontrado para análise${
          error ? ` (${error.message})` : ''
        }.`,
      );
      return null;
    }
    if (data.deletado_em || !data.storage_path) {
      this.logger.log(`Documento ${documentId} já foi excluído — análise ignorada.`);
      return null;
    }
    if (data.status === 'done') {
      // Já analisado (ex.: enqueue duplicado). Nada a fazer.
      return null;
    }
    return data;
  }

  private async downloadFromStorage(storagePath: string): Promise<Buffer> {
    const bucket = this.config.get<string>('supabase.storageBucket')!;
    const { data, error } = await this.db().storage.from(bucket).download(storagePath);

    if (error || !data) {
      throw new Error(
        `Falha ao baixar o arquivo do Storage${error ? `: ${error.message}` : ''}.`,
      );
    }
    return Buffer.from(await data.arrayBuffer());
  }

  private async setStatus(
    documentId: string,
    status: 'processing' | 'done' | 'error',
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const { error } = await this.db()
      .from('documents')
      .update({ status, ...extra })
      .eq('id', documentId);

    if (error) {
      this.logger.error(
        `Falha ao atualizar status do documento ${documentId} para '${status}': ${error.message}`,
      );
    }
  }
}
