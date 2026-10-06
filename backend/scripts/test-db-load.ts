/**
 * Teste OFFLINE das três mudanças que tiram carga do banco:
 *   1. cache do aceite dos termos (TermsAcceptedGuard) — uma consulta ao banco
 *      a cada requisição de documentos vira uma a cada alguns minutos
 *   2. limpeza em lotes de refresh tokens expirados (RetentionService)
 *   3. intervalo crescente do polling do frontend (frontend/src/lib/polling.ts)
 */
import { ForbiddenException, Logger } from '@nestjs/common';
import { TermsAcceptedGuard } from '../src/common/guards/terms-accepted.guard';
import { RetentionService } from '../src/documents/retention.service';
import { pollDelayMs } from '../../frontend/src/lib/polling';

const resultados: boolean[] = [];
const check = (nome: string, ok: boolean, extra = '') => {
  resultados.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${nome}${extra ? ' — ' + extra : ''}`);
};

// ---------- fakes -----------------------------------------------------------
class FakeRedis {
  store = new Map<string, string>();
  falharGet = false;
  falharSet = false;
  async get(k: string) { if (this.falharGet) throw new Error('redis fora'); return this.store.get(k) ?? null; }
  async set(k: string, v: string) { if (this.falharSet) throw new Error('redis fora'); this.store.set(k, v); return 'OK'; }
}

function fakeUsersDb(row: { terms_accepted: boolean; terms_version: string | null }) {
  const db = { consultas: 0, row };
  const client = { from: () => ({ select: () => ({ eq: () => ({ single: async () => { db.consultas++; return { data: db.row, error: null }; } }) }) }) };
  return Object.assign(db, { getClient: () => client });
}

const ctx = (id = 'u1') => ({ switchToHttp: () => ({ getRequest: () => ({ user: { id } }) }) }) as any;
const config = (versao: { v: string }) => ({ get: (k: string) => (k === 'terms.currentVersion' ? versao.v : 'documents') });

type TokenRow = { id: string; expires_at: string; revoked: boolean; created_at: string };

function fakeTokensDb(expirados: number, validos: number, erroNoSelect = false, extras: TokenRow[] = []) {
  const rows: TokenRow[] = [];
  const passado = new Date(Date.now() - 86_400_000).toISOString();
  const futuro = new Date(Date.now() + 86_400_000).toISOString();
  const agora = new Date().toISOString();
  for (let i = 0; i < expirados; i++) rows.push({ id: `e${i}`, expires_at: passado, revoked: false, created_at: agora });
  for (let i = 0; i < validos; i++) rows.push({ id: `v${i}`, expires_at: futuro, revoked: false, created_at: agora });
  rows.push(...extras);
  const db = { rows, deletes: 0 };
  // filtros encadeáveis (lt/eq) como o PostgREST; limit() executa
  const filtros = (lista: Array<(r: TokenRow) => boolean> = []): any => ({
    lt: (c: keyof TokenRow, v: string) => filtros([...lista, (r) => String(r[c]) < v]),
    eq: (c: keyof TokenRow, v: unknown) => filtros([...lista, (r) => r[c] === v]),
    limit: async (n: number) =>
      erroNoSelect
        ? { data: null, error: { message: 'select falhou' } }
        : { data: rows.filter((r) => lista.every((f) => f(r))).slice(0, n).map((r) => ({ id: r.id })), error: null },
  });
  const client = {
    from: () => ({
      select: () => filtros(),
      delete: () => ({
        in: async (_c: string, ids: string[]) => {
          db.deletes++;
          for (const id of ids) rows.splice(rows.findIndex((r) => r.id === id), 1);
          return { error: null };
        },
      }),
    }),
  };
  return Object.assign(db, { getClient: () => client });
}

async function main() {
  Logger.overrideLogger(false);

  // ===== 1. cache dos termos ====================================================
  {
    const redis = new FakeRedis();
    const db = fakeUsersDb({ terms_accepted: true, terms_version: '1.0.0' });
    const g = new TermsAcceptedGuard(db as any, config({ v: '1.0.0' }) as any, redis as any);
    for (let i = 0; i < 5; i++) await g.canActivate(ctx());
    check('5 requisições do mesmo usuário: 1 única consulta ao banco', db.consultas === 1, `${db.consultas} consulta(s)`);
    await g.canActivate(ctx('outro-usuario'));
    check('outro usuário é consultado à parte', db.consultas === 2);
  }
  {
    const redis = new FakeRedis();
    const db = fakeUsersDb({ terms_accepted: false, terms_version: null });
    const g = new TermsAcceptedGuard(db as any, config({ v: '1.0.0' }) as any, redis as any);
    let barrados = 0;
    for (let i = 0; i < 3; i++) { try { await g.canActivate(ctx()); } catch (e) { if (e instanceof ForbiddenException) barrados++; } }
    check('quem NÃO aceitou é barrado sempre e nunca fica em cache', barrados === 3 && db.consultas === 3 && redis.store.size === 0, `barrados=${barrados}, consultas=${db.consultas}`);
  }
  {
    const redis = new FakeRedis();
    const db = fakeUsersDb({ terms_accepted: true, terms_version: '1.0.0' });
    const versao = { v: '1.0.0' };
    const g = new TermsAcceptedGuard(db as any, config(versao) as any, redis as any);
    await g.canActivate(ctx());
    versao.v = '2.0.0';
    let barrou = false;
    try { await g.canActivate(ctx()); } catch { barrou = true; }
    check('nova versão do termo: o cache antigo não vale (reavalia no banco e barra)', barrou && db.consultas === 2);
  }
  {
    const redis = new FakeRedis();
    redis.falharGet = true;
    redis.falharSet = true;
    const db = fakeUsersDb({ terms_accepted: true, terms_version: '1.0.0' });
    const g = new TermsAcceptedGuard(db as any, config({ v: '1.0.0' }) as any, redis as any);
    let ok = true;
    try { await g.canActivate(ctx()); await g.canActivate(ctx()); } catch { ok = false; }
    check('erro do Redis na leitura e na escrita: segue funcionando pelo banco', ok && db.consultas === 2);
  }

  // ===== 2. limpeza de refresh tokens ============================================
  {
    const db = fakeTokensDb(250, 30);
    const apagados = await new RetentionService(db as any, {} as any, {} as any).purgeStaleRefreshTokens();
    check('apaga os 250 expirados em lotes e preserva os 30 válidos', apagados === 250 && db.rows.length === 30 && db.rows.every((r) => r.id.startsWith('v')), `apagados=${apagados}, restam=${db.rows.length}, DELETEs=${db.deletes}`);
  }
  {
    const velho = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const recente = new Date(Date.now() - 3_600_000).toISOString();
    const futuro = new Date(Date.now() + 86_400_000).toISOString();
    const db = fakeTokensDb(0, 0, false, [
      { id: 'rev-velho', expires_at: futuro, revoked: true, created_at: velho },
      { id: 'rev-recente', expires_at: futuro, revoked: true, created_at: recente },
      { id: 'ativo-velho', expires_at: futuro, revoked: false, created_at: velho },
    ]);
    const apagados = await new RetentionService(db as any, {} as any, {} as any).purgeStaleRefreshTokens();
    const restam = db.rows.map((r) => r.id).sort().join(',');
    check('apaga o revogado há mais de 1 dia; preserva o revogado recente (detecta reuso) e o ativo antigo', apagados === 1 && restam === 'ativo-velho,rev-recente', `apagados=${apagados}, restam=${restam}`);
  }
  {
    const db = fakeTokensDb(0, 10);
    const apagados = await new RetentionService(db as any, {} as any, {} as any).purgeStaleRefreshTokens();
    check('sem expirados: não apaga nada e não faz DELETE', apagados === 0 && db.deletes === 0 && db.rows.length === 10);
  }
  {
    const db = fakeTokensDb(6000, 0);
    const apagados = await new RetentionService(db as any, {} as any, {} as any).purgeStaleRefreshTokens();
    check('um acúmulo grande é limitado por execução (50 lotes de 100) e o resto fica para a próxima', apagados === 5000 && db.rows.length === 1000, `apagados=${apagados}, restam=${db.rows.length}`);
  }
  {
    const db = fakeTokensDb(10, 0, true);
    let lancou = false;
    let apagados = -1;
    try { apagados = await new RetentionService(db as any, {} as any, {} as any).purgeStaleRefreshTokens(); } catch { lancou = true; }
    check('erro do banco ao listar: não lança e não apaga nada', !lancou && apagados === 0 && db.rows.length === 10);
  }

  // ===== 3. polling com intervalo crescente =======================================
  check('intervalos: 4 s nas 5 primeiras, 8 s nas 5 seguintes, 15 s depois', [0, 4].every((a) => pollDelayMs(a) === 4000) && [5, 9].every((a) => pollDelayMs(a) === 8000) && [10, 50].every((a) => pollDelayMs(a) === 15000));
  check('aba oculta: 30 s', pollDelayMs(0, true) === 30000 && pollDelayMs(20, true) === 30000);
  {
    const consultasEm = (segundos: number) => { let t = 0; let n = 0; let tentativa = 0; while (true) { t += pollDelayMs(tentativa++) / 1000; if (t > segundos) break; n++; } return n; };
    for (const seg of [60, 100, 180]) {
      const antes = Math.floor(seg / 4);
      const depois = consultasEm(seg);
      console.log(`   análise de ${seg}s: ${antes} consultas (4 s fixo) → ${depois} (crescente), ${Math.round((1 - depois / antes) * 100)}% a menos`);
    }
    check('uma análise de 100 s gera pelo menos 45% menos consultas que o intervalo fixo de 4 s', consultasEm(100) <= Math.floor(100 / 4) * 0.55, `${Math.floor(100 / 4)} → ${consultasEm(100)}`);
  }

  const ok = resultados.every(Boolean);
  console.log(ok ? `\n✅ ${resultados.length} de ${resultados.length} verificações passaram.` : `\n❌ ${resultados.filter((r) => !r).length} verificação(ões) falharam.`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => { console.error('FALHA:', e instanceof Error ? e.stack : e); process.exit(1); });
