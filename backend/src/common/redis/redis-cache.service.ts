import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS_CLIENT } from './redis.constants';

/**
 * Fase 3 — Cache/contador genérico sobre o Redis compartilhado.
 * Qualquer réplica que ler/escrever uma chave enxerga o mesmo valor.
 */
@Injectable()
export class RedisCacheService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.redis.set(key, value, 'EX', ttlSeconds);
    } else {
      await this.redis.set(key, value);
    }
  }

  // INCR é atômico no Redis: várias réplicas incrementando ao mesmo tempo
  // nunca perdem contagem.
  async increment(key: string): Promise<number> {
    return this.redis.incr(key);
  }
}
