import { Global, Logger, Module, OnApplicationShutdown, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * Fase 1 — Cliente Redis compartilhado (fundação para rate limit, cache e fila).
 * Uma única conexão, reutilizável por qualquer módulo via @Inject(REDIS_CLIENT).
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Redis => {
        const logger = new Logger('Redis');
        const client = new Redis(config.get<string>('redis.url')!, {
          maxRetriesPerRequest: null, // exigido por BullMQ nas fases seguintes
        });
        client.on('connect', () => logger.log('Conectado ao Redis'));
        client.on('error', (err) => logger.error(`Erro no Redis: ${err.message}`));
        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly client: Redis) {}

  async onApplicationShutdown() {
    await this.client.quit();
  }
}
