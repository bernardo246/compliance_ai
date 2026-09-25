import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SupabaseService } from '../common/supabase/supabase.service';

export const ANALISES_QUEUE = 'analises';

export interface AnalisarJobData {
  documentId: string;
}

/**
 * Fase 4 — produtor da fila de análise (BullMQ/Redis).
 *
 * Substitui a fila em memória do antigo AnalysisRunnerService: o job vive no
 * Redis, então qualquer réplica pode enfileirar e qualquer worker (de
 * qualquer réplica) pode processar.
 */
@Injectable()
export class AnalysisQueueService implements OnModuleInit {
  private readonly logger = new Logger(AnalysisQueueService.name);

  constructor(
    @InjectQueue(ANALISES_QUEUE) private readonly queue: Queue<AnalisarJobData>,
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    void this.recoverPending();
  }

  /**
   * Fire-and-forget. `jobId = documentId` torna a operação idempotente: se já
   * existe um job pendente/ativo para o documento, o Redis ignora o novo.
   * `removeOnComplete/Fail` libera o jobId ao terminar, permitindo reanálise.
   */
  async enqueue(documentId: string): Promise<void> {
    try {
      await this.queue.add(
        'analisar',
        { documentId },
        { jobId: documentId, removeOnComplete: true, removeOnFail: true },
      );
    } catch (err) {
      // Não derruba o upload: o documento fica 'uploaded' e o recoverPending
      // do próximo boot o reenfileira.
      this.logger.error(
        `Falha ao enfileirar documento ${documentId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  /**
   * No boot: reenfileira 'uploaded' (enqueue perdido) e 'processing' antigo
   * (worker caiu no meio). O jobId deduplica: com várias réplicas subindo
   * juntas, ou com o job ainda ativo em outro worker, nada é duplicado.
   */
  private async recoverPending(): Promise<void> {
    const stuckBefore = new Date(
      Date.now() - (this.config.get<number>('analysis.stuckTimeoutMs') ?? 600_000),
    ).toISOString();

    const { data, error } = await this.supabase
      .getClient()
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
      await this.enqueue(doc.id);
    }
  }
}
