import { Controller, Get, NotFoundException, Req } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SkipThrottle } from '@nestjs/throttler';
import { Request } from 'express';
import { Public } from '../decorators/public.decorator';
import { RedisCacheService } from '../redis/redis-cache.service';

/**
 * Fase 3 — endpoint de diagnóstico, só para provar estado compartilhado entre
 * réplicas: devolve qual instância respondeu (HOSTNAME = ID do container no
 * Docker) e um contador que vive no Redis, não na memória do processo.
 * `ip` é o req.ip que o rate limit usa: prova que TRUST_PROXY + X-Forwarded-For
 * do Nginx entregam o IP do cliente e não o do proxy.
 * Fora do rate limit de propósito: os testes de load balancer mandam centenas
 * de requisições por minuto (o limite em si é provado pelo /api/auth/login).
 * Desligado por padrão: sem ENABLE_DEBUG_ENDPOINT=true responde 404, como se
 * a rota não existisse. Não ligar em produção.
 */
@SkipThrottle()
@Controller('api/debug')
export class DebugController {
  constructor(
    private readonly cache: RedisCacheService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Get('instance')
  async instance(@Req() req: Request) {
    if (!this.config.get<boolean>('debug.enabled')) {
      throw new NotFoundException();
    }
    const hits = await this.cache.increment('debug:hits');
    return {
      instanceId: process.env.HOSTNAME ?? `pid-${process.pid}`,
      hits,
      ip: req.ip,
      timestamp: new Date().toISOString(),
    };
  }
}
