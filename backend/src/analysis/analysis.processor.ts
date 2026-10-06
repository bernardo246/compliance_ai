import { Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.constants';
import { SupabaseService } from '../common/supabase/supabase.service';
import { HEARTBEAT_VARREDURA, contarJobFalho, registrarBatimento } from '../monitoring/monitoring.keys';
import { AreaNegocio } from '../documents/dto/upload-document.dto';
import { TipoDocumento } from '../documents/documents.types';
import { AnalysisService } from './analysis.service';
import {
  ANALISES_QUEUE,
  AnalisarJobData,
  AnalysisQueueService,
  RECUPERAR_JOB,
  RECUPERAR_UPLOADED_MIN_AGE_MS,
} from './analysis-queue.service';

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
    private readonly queueService: AnalysisQueueService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    super();
  }

  // Espera base entre tentativas de gravar no banco (3s, 6s...). Campo (e não
  // constante) para o teste offline poder encurtar.
  private retryBaseMs = 3000;

  private db() {
    return this.supabase.getClient();
  }

  async process(job: Job<AnalisarJobData>): Promise<void> {
    if (job.name === RECUPERAR_JOB) {
      // Varredura periódica de documentos parados (agendada pelo
      // AnalysisQueueService): rede de segurança para quando uma gravação de
      // status falhou e nenhum job ficou para trás.
      await this.queueService.recoverPending(RECUPERAR_UPLOADED_MIN_AGE_MS, 'varredura periódica');
      await registrarBatimento(this.redis, HEARTBEAT_VARREDURA);
      return;
    }
    await this.run(job.data.documentId);
  }

  /**
   * Rede de segurança: o BullMQ falha o job de vez quando ele trava mais de
   * uma vez (ex.: duas réplicas caem seguidas no meio da análise) e, com
   * removeOnFail, apaga o job. Sem isto o documento ficaria em 'processing'
   * para sempre. Só mexe em documentos ainda 'uploaded'/'processing' — nunca
   * sobrescreve um 'done' — e é idempotente (várias réplicas podem receber).
   */
  @OnWorkerEvent('failed')
  async onJobFailed(job: Job<AnalisarJobData> | undefined, err: Error): Promise<void> {
    const documentId = job?.data?.documentId;
    if (!documentId) return;

    this.logger.error(
      `Job de análise do documento ${documentId} falhou definitivamente: ${err.message}`,
    );
    await contarJobFalho(this.redis);
    await this.updateDocument(
      documentId,
      {
        status: 'error',
        erro: 'A análise foi interrompida por uma falha no servidor antes de terminar. Envie o documento novamente.',
      },
      { onlyIfStatus: ['uploaded', 'processing'] },
    );
  }

  private async run(documentId: string): Promise<void> {
    const doc = await this.loadDocument(documentId);
    if (!doc) return;

    // Reivindica o documento de forma ATÔMICA: a checagem do loadDocument e esta
    // gravação são dois passos, e entre eles o documento pode ter sido concluído
    // por outro worker ou excluído pelo usuário. O UPDATE condicional só pega
    // documentos ainda analisáveis; se não alterou nenhuma linha, outro já
    // cuidou dele e este job para aqui, sem chamar a IA.
    if (!(await this.claimForProcessing(documentId))) {
      this.logger.log(
        `Documento ${documentId} não pôde ser reivindicado (já concluído, excluído ou banco indisponível) — análise ignorada.`,
      );
      return;
    }

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
      // Só se o documento ainda estiver em andamento: se outro worker (ex.: o que
      // assumiu depois que este travou) já o concluiu, o 'done' não é sobrescrito.
      await this.updateDocument(
        documentId,
        { status: 'error', erro: mensagem.slice(0, 500) },
        { onlyIfStatus: ['uploaded', 'processing'] },
      );
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
    if (data.status === 'done' || data.status === 'error') {
      // Estados finais: 'done' (já analisado, ex.: enqueue duplicado) e 'error'
      // (falhou de vez; o usuário reenvia o documento — nada reenfileira um
      // documento em 'error', e um job tardio para ele não o reanalisa).
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
    await this.updateDocument(documentId, { status, ...extra });
  }

  private async claimForProcessing(documentId: string): Promise<boolean> {
    const { ok, updated } = await this.updateDocument(
      documentId,
      { status: 'processing', processing_started_at: new Date().toISOString(), erro: null },
      { onlyIfStatus: ['uploaded', 'processing'], notDeleted: true },
    );
    return ok && updated > 0;
  }

  /**
   * Grava em `documents` com algumas tentativas: o banco pode ficar fora do ar
   * por instantes, e estas gravações são o que tira o documento de
   * 'processing'. Se todas falharem, só registra o erro (não relança): o job
   * termina e a varredura periódica (RECUPERAR_JOB) reenfileira o documento
   * quando ele passar de ANALYSIS_STUCK_TIMEOUT_MS parado.
   * `onlyIfStatus` restringe a gravação a documentos ainda nesses estados
   * (para nunca sobrescrever um 'done') e `notDeleted` a documentos não
   * excluídos. `updated` é quantas linhas a gravação realmente alterou.
   */
  private async updateDocument(
    documentId: string,
    patch: Record<string, unknown>,
    options: { onlyIfStatus?: string[]; notDeleted?: boolean } = {},
  ): Promise<{ ok: boolean; updated: number }> {
    const maxTentativas = 3;
    let ultimoErro = '';
    for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
      try {
        let query = this.db().from('documents').update(patch).eq('id', documentId);
        if (options.onlyIfStatus) query = query.in('status', options.onlyIfStatus);
        if (options.notDeleted) query = query.is('deletado_em', null);
        const { data, error } = await query.select('id');
        if (!error) return { ok: true, updated: data?.length ?? 0 };
        ultimoErro = error.message;
      } catch (e) {
        ultimoErro = e instanceof Error ? e.message : String(e);
      }
      if (tentativa < maxTentativas) {
        await new Promise((r) => setTimeout(r, this.retryBaseMs * tentativa));
      }
    }
    this.logger.error(
      `Falha ao atualizar o documento ${documentId} (${JSON.stringify(
        patch.status ?? Object.keys(patch),
      )}) após ${maxTentativas} tentativas: ${ultimoErro}`,
    );
    return { ok: false, updated: 0 };
  }
}
