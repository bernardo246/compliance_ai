import { Controller, Get, Inject, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import Redis from 'ioredis';
import { Public } from './common/decorators/public.decorator';
import { REDIS_CLIENT } from './common/redis/redis.constants';
import { SupabaseService } from './common/supabase/supabase.service';

const TIMEOUT_MS = 2000;
const CACHE_MS = 5000;

const comTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

@Controller('api/health')
export class HealthController {
  private ultimo: { em: number; corpo: { status: string; redis: string; banco: string }; http: number } | null = null;

  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly supabase: SupabaseService,
  ) {}

  /** Liveness: o processo está de pé. É o que o healthcheck do container usa. */
  @Public()
  @Get()
  check() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  /**
   * Readiness: o app consegue falar com o Redis e com o banco? É o endpoint para
   * um monitor EXTERNO de disponibilidade (responde 503 se algo estiver fora).
   * Fora do rate limit (precisa responder mesmo se o Redis, de que o rate limit
   * depende, estiver caído) e com cache de 5 s por réplica para não virar uma
   * porta aberta para martelar o banco.
   */
  @Public()
  @SkipThrottle()
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const agora = Date.now();
    if (!this.ultimo || agora - this.ultimo.em > CACHE_MS) {
      const [redis, banco] = await Promise.all([
        comTimeout(this.redis.ping(), TIMEOUT_MS).then(() => 'ok', () => 'falhou'),
        comTimeout(
          Promise.resolve(this.supabase.getClient().from('users').select('id').limit(1)).then((r) => {
            if (r.error) throw new Error(r.error.message);
          }),
          TIMEOUT_MS,
        ).then(() => 'ok', () => 'falhou'),
      ]);
      const ok = redis === 'ok' && banco === 'ok';
      this.ultimo = { em: agora, corpo: { status: ok ? 'ok' : 'degradado', redis, banco }, http: ok ? 200 : 503 };
    }
    res.status(this.ultimo.http);
    return { ...this.ultimo.corpo, timestamp: new Date().toISOString() };
  }
}
