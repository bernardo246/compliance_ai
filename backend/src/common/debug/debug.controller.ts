import { Controller, Get } from '@nestjs/common';
import { Public } from '../decorators/public.decorator';
import { RedisCacheService } from '../redis/redis-cache.service';

/**
 * Fase 3 — endpoint de diagnóstico, só para provar estado compartilhado entre
 * réplicas: devolve qual instância respondeu (HOSTNAME = ID do container no
 * Docker) e um contador que vive no Redis, não na memória do processo.
 * Não usar em produção sem proteger/remover.
 */
@Controller('api/debug')
export class DebugController {
  constructor(private readonly cache: RedisCacheService) {}

  @Public()
  @Get('instance')
  async instance() {
    const hits = await this.cache.increment('debug:hits');
    return {
      instanceId: process.env.HOSTNAME ?? `pid-${process.pid}`,
      hits,
      timestamp: new Date().toISOString(),
    };
  }
}
