import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { BullModule } from '@nestjs/bullmq';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import configuration from './config/configuration';
import { RedisModule, REDIS_CLIENT } from './common/redis/redis.module';
import { SupabaseModule } from './common/supabase/supabase.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { DocumentsModule } from './documents/documents.module';
import { AnalysisModule } from './analysis/analysis.module';
import { HealthController } from './health.controller';
import { DebugController } from './common/debug/debug.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    ScheduleModule.forRoot(), // Fase 7 — habilita @Cron() (RetentionService)
    RedisModule,
    ThrottlerModule.forRootAsync({
      inject: [REDIS_CLIENT],
      useFactory: (redis: Redis) => ({
        // Fase 2 — contadores no Redis (não na memória do Node): o limite
        // vale globalmente, somando as requisições de todas as réplicas.
        throttlers: [
          {
            // Fase 0/8 — rate limit básico contra brute-force em login/registro.
            ttl: 60_000,
            limit: 30,
          },
        ],
        storage: new ThrottlerStorageRedisService(redis),
      }),
    }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        // Fase 4 — BullMQ abre conexões próprias (Workers usam comandos
        // bloqueantes e não podem dividir a conexão do cache/throttler).
        connection: { url: config.get<string>('redis.url')! },
      }),
    }),
    SupabaseModule,
    AuthModule,
    UsersModule,
    DocumentsModule,
    AnalysisModule,
  ],
  controllers: [HealthController, DebugController],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
