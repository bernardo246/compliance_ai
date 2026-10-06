/**
 * Teste OFFLINE do rate limit resiliente (src/common/redis/resilient-throttler-storage.ts):
 * com o Redis saudável usa o Redis; se ele der erro ou travar, o limite continua valendo
 * em memória daquela réplica (a API não trava); quando ele volta, volta a ser o Redis.
 */
import { Logger } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { ResilientThrottlerStorage } from '../src/common/redis/resilient-throttler-storage';

const resultados: boolean[] = [];
const check = (nome: string, ok: boolean, extra = '') => {
  resultados.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${nome}${extra ? ' — ' + extra : ''}`);
};

class PrimarioFalso implements ThrottlerStorage {
  modo: 'ok' | 'erro' | 'trava' = 'ok';
  chamadas = 0;
  hits = new Map<string, number>();
  async increment(key: string, _ttl: number, limit: number) {
    this.chamadas++;
    if (this.modo === 'erro') throw new Error('Stream isn\'t writeable and enableOfflineQueue options is false');
    if (this.modo === 'trava') return new Promise<never>(() => undefined);
    const n = (this.hits.get(key) ?? 0) + 1;
    this.hits.set(key, n);
    return { totalHits: n, timeToExpire: 60, isBlocked: n > limit, timeToBlockExpire: 0 };
  }
}

async function main() {
  Logger.overrideLogger(false);
  const primario = new PrimarioFalso();
  const reserva = new ThrottlerStorageService();
  const storage = new ResilientThrottlerStorage(primario, reserva, 150);
  // O guard real passa blockDuration = ttl quando a rota não define outro (throttler.guard.js:84).
  const inc = (key = 'login-ip1') => storage.increment(key, 60_000, 2, 60_000, 'default');

  // 1. saudável
  const a = await inc();
  check('Redis saudável: usa o Redis (e não toca a reserva)', a.totalHits === 1 && primario.hits.get('login-ip1') === 1 && reserva.storage.size === 0);

  // 2. com erro: o limite continua valendo em memória
  primario.modo = 'erro';
  const r1 = await inc('login-ip2');
  const r2 = await inc('login-ip2');
  const r3 = await inc('login-ip2');
  check('Redis com erro: a requisição NÃO falha, o contador em memória conta (1, 2, 3)', r1.totalHits === 1 && r2.totalHits === 2 && r3.totalHits === 3, `hits=${r1.totalHits},${r2.totalHits},${r3.totalHits}`);
  check('...e o limite (2) continua valendo: a 3ª tentativa é bloqueada', !r1.isBlocked && !r2.isBlocked && r3.isBlocked);
  const outro = await inc('login-ip3');
  check('chaves diferentes (IPs diferentes) não se misturam na reserva', outro.totalHits === 1 && !outro.isBlocked);

  // 3. Redis travado (não responde)
  primario.modo = 'trava';
  const t0 = Date.now();
  const t = await inc('login-ip4');
  const ms = Date.now() - t0;
  check('Redis travado: responde em ~150 ms pela reserva, sem esperar para sempre', t.totalHits === 1 && ms < 1000, `${ms} ms`);

  // 4. Redis volta
  primario.modo = 'ok';
  const antes = primario.chamadas;
  const v = await inc('login-ip5');
  check('Redis de volta: volta a usar o Redis (contador compartilhado)', primario.chamadas === antes + 1 && v.totalHits === 1 && primario.hits.get('login-ip5') === 1);

  storage.close();
  const ok = resultados.every(Boolean);
  console.log(ok ? `\n✅ ${resultados.length} de ${resultados.length} verificações passaram.` : `\n❌ ${resultados.filter((r) => !r).length} verificação(ões) falharam.`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => { console.error('FALHA:', e instanceof Error ? e.stack : e); process.exit(1); });
