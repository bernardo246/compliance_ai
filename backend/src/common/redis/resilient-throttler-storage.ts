import { Logger } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';

type Registro = Awaited<ReturnType<ThrottlerStorage['increment']>>;

/**
 * Armazenamento do rate limit que NÃO derruba a API quando o Redis cai.
 *
 * Normalmente os contadores ficam no Redis (valem somados entre todas as
 * réplicas). Se o Redis não responder em `timeoutMs` (ou der erro), usa um
 * contador em memória DAQUELA réplica: o limite continua valendo, só deixa de
 * ser somado entre réplicas (fica até N vezes mais folgado com N réplicas) até o
 * Redis voltar. Sem isto, o guard de rate limit esperava o Redis responder e
 * TODAS as rotas (login, até o healthcheck) travavam durante a queda.
 */
export class ResilientThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger('RateLimit');
  private ultimoAviso = 0;

  constructor(
    private readonly primario: ThrottlerStorage,
    private readonly reserva: ThrottlerStorageService = new ThrottlerStorageService(),
    private readonly timeoutMs = 500,
  ) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<Registro> {
    try {
      return await Promise.race([
        this.primario.increment(key, ttl, limit, blockDuration, throttlerName),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), this.timeoutMs)),
      ]);
    } catch (e) {
      const agora = Date.now();
      if (agora - this.ultimoAviso > 30_000) {
        this.ultimoAviso = agora;
        this.logger.warn(
          `Redis indisponível para o rate limit (${e instanceof Error ? e.message : e}): usando contador em memória desta réplica até ele voltar.`,
        );
      }
      return this.reserva.increment(key, ttl, limit, blockDuration, throttlerName);
    }
  }

  /** Libera os timers do contador em memória (usado ao encerrar e nos testes). */
  close() {
    this.reserva.onApplicationShutdown();
  }
}
