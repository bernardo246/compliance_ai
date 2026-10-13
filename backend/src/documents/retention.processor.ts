import { Inject } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.constants';
import { HEARTBEAT_RETENCAO, registrarBatimento } from '../monitoring/monitoring.keys';
import { RETENCAO_QUEUE, RetentionService } from './retention.service';

/** Worker do job repetível de retenção (de hora em hora): arquivos de 72h, refresh tokens vencidos, auditoria e resposta bruta da IA antigas. */
@Processor(RETENCAO_QUEUE)
export class RetentionProcessor extends WorkerHost {
  constructor(
    private readonly retention: RetentionService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {
    super();
  }

  async process(): Promise<void> {
    await this.retention.purgeExpired();
    await this.retention.purgeStaleRefreshTokens();
    await this.retention.purgeOldAuditLogs();
    await this.retention.purgeOldRawResponses();
    await registrarBatimento(this.redis, HEARTBEAT_RETENCAO);
  }
}
