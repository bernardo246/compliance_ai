import { Processor, WorkerHost } from '@nestjs/bullmq';
import { RETENCAO_QUEUE, RetentionService } from './retention.service';

/** Fase 5 — worker do job repetível de retenção (72h). */
@Processor(RETENCAO_QUEUE)
export class RetentionProcessor extends WorkerHost {
  constructor(private readonly retention: RetentionService) {
    super();
  }

  async process(): Promise<void> {
    await this.retention.purgeExpired();
  }
}
