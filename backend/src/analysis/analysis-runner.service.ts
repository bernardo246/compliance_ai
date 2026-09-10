import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../common/supabase/supabase.service';
import { AreaNegocio } from '../documents/dto/upload-document.dto';
import { TipoDocumento } from '../documents/documents.types';
import { AnalysisService } from './analysis.service';

interface PendingDocument {
  id: string;
  tipo: TipoDocumento;
  area_negocio: AreaNegocio;
  storage_path: string | null;
  status: string;
  deletado_em: string | null;
}

/**
 * Fase 5 — pipeline assíncrono in-process (sem Redis).
 *
 * `DocumentsService.upload()` chama `enqueue(documentId)` sem `await`: a
 * resposta HTTP do upload volta na hora e a análise roda em background aqui.
 *
 * A "fila" é um array em memória com um limite de concorrência. É suficiente
 * para uma instância única do backend. As duas fraquezas conhecidas em relação
 * a uma fila real (BullMQ/Redis) são tratadas de forma simples:
 *
 *  - **Perda no restart:** se o processo cai, o que estava na fila some. No
 *    boot, `recoverPending()` varre `documents` e reenfileira tudo que ficou
 *    em 'uploaded' (enqueue perdido) ou 'processing' há muito tempo (crash no
 *    meio da análise).
 *  - **Idempotência:** `analyses` tem `unique(document_id)` e a gravação é um
 *    upsert — reprocessar um documento não duplica linha.
 */
@Injectable()
export class AnalysisRunnerService implements OnModuleInit {
  private readonly logger = new Logger(AnalysisRunnerService.name);

  private readonly queue: string[] = [];
  private readonly inFlight = new Set<string>();
  private activeCount = 0;

  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
    private readonly analysisService: AnalysisService,
  ) {}

  onModuleInit() {
    void this.recoverPending();
  }

  private db() {
    return this.supabase.getClient();
  }

  private get concurrency(): number {
    return this.config.get<number>('analysis.concurrency') ?? 2;
  }

  /**
   * Coloca um documento na fila de análise. Fire-and-forget: quem chama não
   * espera. Idempotente — chamar de novo com o mesmo id enquanto ele já está
   * na fila ou em processamento não faz nada.
   */
  enqueue(documentId: string): void {
    if (this.queue.includes(documentId) || this.inFlight.has(documentId)) {
      return;
    }
    this.queue.push(documentId);
    this.drain();
  }

  private drain(): void {
    while (this.activeCount < this.concurrency && this.queue.length > 0) {
      const documentId = this.queue.shift()!;
      this.inFlight.add(documentId);
      this.activeCount += 1;

      void this.process(documentId)
        .catch((err) => {
          // process() já trata os erros esperados (marca o doc como 'error').
          // Um throw aqui é bug inesperado no próprio runner — loga e segue.
          this.logger.error(
            `Erro não tratado ao processar documento ${documentId}: ${
              err instanceof Error ? err.stack : err
            }`,
          );
        })
        .finally(() => {
          this.activeCount -= 1;
          this.inFlight.delete(documentId);
          this.drain();
        });
    }
  }

  /**
   * No boot: reenfileira análises que ficaram pendentes.
   *  - status 'uploaded'  → o upload gravou o doc mas o enqueue se perdeu
   *  - status 'processing' antigo → o processo caiu no meio da análise
   */
  private async recoverPending(): Promise<void> {
    const stuckBefore = new Date(
      Date.now() - (this.config.get<number>('analysis.stuckTimeoutMs') ?? 600_000),
    ).toISOString();

    const { data, error } = await this.db()
      .from('documents')
      .select('id, status, processing_started_at')
      .is('deletado_em', null)
      .in('status', ['uploaded', 'processing']);

    if (error) {
      this.logger.error(`Falha ao varrer documentos pendentes no boot: ${error.message}`);
      return;
    }

    const toRecover = (data ?? []).filter(
      (doc) =>
        doc.status === 'uploaded' ||
        !doc.processing_started_at ||
        doc.processing_started_at < stuckBefore,
    );

    if (toRecover.length === 0) return;

    this.logger.log(`Recuperando ${toRecover.length} análise(s) pendente(s) após o boot.`);
    for (const doc of toRecover) {
      this.enqueue(doc.id);
    }
  }

  private async process(documentId: string): Promise<void> {
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
