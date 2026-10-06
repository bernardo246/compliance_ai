import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SupabaseService } from '../common/supabase/supabase.service';

export const ANALISES_QUEUE = 'analises';

export const RECUPERAR_JOB = 'recuperar';
// Na varredura periódica, um documento 'uploaded' só conta como parado depois
// disso (evita reenfileirar um upload que acabou de acontecer).
export const RECUPERAR_UPLOADED_MIN_AGE_MS = 120_000;

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
    @InjectQueue(ANALISES_QUEUE) private readonly queue: Queue,
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    void this.recoverPending(0, 'após o boot');
    await this.scheduleRecovery();
  }

  /**
   * Agenda a varredura periódica como job repetível do BullMQ: todas as
   * réplicas registram o mesmo scheduler (idempotente) e o Redis dispara UMA
   * execução por intervalo, processada por um worker qualquer. É a rede de
   * segurança para documentos que ficaram parados sem job na fila — ex.: o
   * banco estava fora quando a análise terminou e a gravação do status falhou.
   */
  private async scheduleRecovery(): Promise<void> {
    const every = this.config.get<number>('analysis.recoveryIntervalMs') ?? 300_000;
    await this.queue.upsertJobScheduler(
      'recuperar-pendentes',
      { every },
      { name: RECUPERAR_JOB, opts: { removeOnComplete: true, removeOnFail: true } },
    );
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
   * Reenfileira análises paradas: 'uploaded' (enqueue perdido; só se tiver mais
   * de `minUploadedAgeMs`) e 'processing' antigo (worker caiu, ou a gravação
   * do status final falhou). O jobId deduplica: com várias réplicas varrendo
   * juntas, ou com o job ainda ativo em outro worker, nada é duplicado.
   */
  async recoverPending(minUploadedAgeMs: number, origem: string): Promise<void> {
    const now = Date.now();
    const stuckBefore = new Date(
      now - (this.config.get<number>('analysis.stuckTimeoutMs') ?? 600_000),
    ).toISOString();
    const uploadedBefore = new Date(now - minUploadedAgeMs).toISOString();

    const { data, error } = await this.supabase
      .getClient()
      .from('documents')
      .select('id, status, processing_started_at, created_at')
      .is('deletado_em', null)
      .in('status', ['uploaded', 'processing']);

    if (error) {
      this.logger.error(`Falha ao varrer documentos pendentes (${origem}): ${error.message}`);
      return;
    }

    const toRecover = (data ?? []).filter((doc) =>
      doc.status === 'uploaded'
        ? doc.created_at <= uploadedBefore
        : !doc.processing_started_at || doc.processing_started_at < stuckBefore,
    );
    if (toRecover.length === 0) return;

    this.logger.log(`Recuperando ${toRecover.length} análise(s) pendente(s) (${origem}).`);
    for (const doc of toRecover) {
      await this.enqueue(doc.id);
    }
  }
}
