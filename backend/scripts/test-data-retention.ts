/**
 * Teste OFFLINE das mudanças pré-deploy:
 *   1. retenção de audit_logs (apaga os antigos) e de analyses.raw_response (zera, sem apagar a análise)
 *   2. concorrência do worker de análise aplicada a partir da configuração
 *   3. findOneForUser só lê a análise quando o status é 'done' (menos leituras no polling)
 */
import { Logger } from '@nestjs/common';
import configuration from '../src/config/configuration';
import { RetentionService } from '../src/documents/retention.service';
import { DocumentsService } from '../src/documents/documents.service';
import { AnalysisProcessor, ANALYSIS_DEFAULT_CONCURRENCY } from '../src/analysis/analysis.processor';

Logger.overrideLogger(false);
const resultados: boolean[] = [];
const check = (nome: string, ok: boolean, extra = '') => {
  resultados.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${nome}${extra ? ' — ' + extra : ''}`);
};
const diasAtras = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

// ---- banco falso: tabelas em memória com select/lt/not/limit/delete/update/in -----------------
type Row = Record<string, any>;
function fakeDb(tabelas: Record<string, Row[]>, falharEm?: { tabela: string; op: 'select' | 'write' }) {
  const log = { selects: 0, writes: 0 };
  const from = (tabela: string) => {
    const st: { op: string; filtros: ((r: Row) => boolean)[]; limit?: number; patch?: Row; ids?: string[] } = { op: 'select', filtros: [] };
    const q: any = {
      select: () => { st.op = 'select'; return q; },
      delete: () => { st.op = 'delete'; return q; },
      update: (patch: Row) => { st.op = 'update'; st.patch = patch; return q; },
      lt: (c: string, v: string) => { st.filtros.push((r) => r[c] < v); return q; },
      not: (c: string, _o: string, v: any) => { st.filtros.push((r) => r[c] !== v && r[c] !== undefined); return q; },
      in: (c: string, v: string[]) => { st.filtros.push((r) => v.includes(r[c])); return q; },
      limit: (n: number) => { st.limit = n; return q; },
      then: (res: (v: any) => void) => {
        if (falharEm && falharEm.tabela === tabela && ((falharEm.op === 'select') === (st.op === 'select'))) {
          return res({ data: null, error: { message: 'banco fora' } });
        }
        let rows = tabelas[tabela].filter((r) => st.filtros.every((f) => f(r)));
        if (st.op === 'select') {
          log.selects++;
          if (st.limit) rows = rows.slice(0, st.limit);
          return res({ data: rows.map((r) => ({ id: r.id })), error: null });
        }
        log.writes++;
        if (st.op === 'delete') tabelas[tabela] = tabelas[tabela].filter((r) => !rows.includes(r));
        if (st.op === 'update') rows.forEach((r) => Object.assign(r, st.patch));
        return res({ data: null, error: null });
      },
    };
    return q;
  };
  return { client: { from }, log };
}
const svc = (db: any, cfg: Record<string, any> = {}) =>
  new RetentionService({ getClient: () => db.client } as any, { get: (k: string) => cfg[k] } as any, {} as any);

async function main() {
  // ===== 1. audit_logs =====
  {
    const t = { audit_logs: [
      { id: 'a-100d', created_at: diasAtras(100) },
      { id: 'a-91d', created_at: diasAtras(91) },
      { id: 'a-89d', created_at: diasAtras(89) },
      { id: 'a-1d', created_at: diasAtras(1) },
    ] };
    const n = await svc(fakeDb(t), { 'dataRetention.auditLogDays': 90 }).purgeOldAuditLogs();
    const restam = t.audit_logs.map((r) => r.id).sort().join(',');
    check('audit_logs: apaga só os mais antigos que 90 dias', n === 2 && restam === 'a-1d,a-89d', `apagados=${n}, restam=${restam}`);
  }
  {
    const t = { audit_logs: [{ id: 'a-40d', created_at: diasAtras(40) }, { id: 'a-10d', created_at: diasAtras(10) }] };
    const n = await svc(fakeDb(t), { 'dataRetention.auditLogDays': 30 }).purgeOldAuditLogs();
    check('audit_logs: o prazo é configurável (30 dias)', n === 1 && t.audit_logs.length === 1);
  }
  {
    const t = { audit_logs: [{ id: 'a-100d', created_at: diasAtras(100) }] };
    const n = await svc(fakeDb(t), {}).purgeOldAuditLogs();
    check('audit_logs: sem configuração usa o padrão de 90 dias', n === 1);
  }
  {
    const t = { audit_logs: Array.from({ length: 6000 }, (_, i) => ({ id: 'x' + i, created_at: diasAtras(200) })) };
    const db = fakeDb(t);
    const n = await svc(db, { 'dataRetention.auditLogDays': 90 }).purgeOldAuditLogs();
    check('audit_logs: acúmulo grande é limitado por passada (50 lotes de 100) e o resto fica para a próxima', n === 5000 && t.audit_logs.length === 1000, `apagados=${n}, restam=${t.audit_logs.length}`);
    const n2 = await svc(db, { 'dataRetention.auditLogDays': 90 }).purgeOldAuditLogs();
    check('audit_logs: a passada seguinte termina de drenar', n2 === 1000 && t.audit_logs.length === 0);
  }
  {
    const t = { audit_logs: [{ id: 'a', created_at: diasAtras(200) }] };
    const n = await svc(fakeDb(t, { tabela: 'audit_logs', op: 'select' }), {}).purgeOldAuditLogs();
    check('audit_logs: erro do banco ao listar não lança e não apaga nada', n === 0 && t.audit_logs.length === 1);
    const t2 = { audit_logs: [{ id: 'a', created_at: diasAtras(200) }] };
    const n2 = await svc(fakeDb(t2, { tabela: 'audit_logs', op: 'write' }), {}).purgeOldAuditLogs();
    check('audit_logs: erro do banco ao apagar não lança', n2 === 0 && t2.audit_logs.length === 1);
  }

  // ===== raw_response =====
  {
    const t = { analyses: [
      { id: 'an-40d', created_at: diasAtras(40), raw_response: 'texto', resumo_executivo: 'r1' },
      { id: 'an-31d', created_at: diasAtras(31), raw_response: 'texto', resumo_executivo: 'r2' },
      { id: 'an-29d', created_at: diasAtras(29), raw_response: 'texto', resumo_executivo: 'r3' },
      { id: 'an-60d-sem', created_at: diasAtras(60), raw_response: null, resumo_executivo: 'r4' },
    ] as Row[] };
    const n = await svc(fakeDb(t), { 'dataRetention.rawResponseDays': 30 }).purgeOldRawResponses();
    const byId = Object.fromEntries(t.analyses.map((r) => [r.id, r]));
    check('raw_response: zera só as análises com mais de 30 dias', n === 2 && byId['an-40d'].raw_response === null && byId['an-31d'].raw_response === null && byId['an-29d'].raw_response === 'texto', `zeradas=${n}`);
    check('raw_response: a análise NÃO é apagada e o resultado estruturado continua', t.analyses.length === 4 && byId['an-40d'].resumo_executivo === 'r1');
    const n2 = await svc(fakeDb(t), { 'dataRetention.rawResponseDays': 30 }).purgeOldRawResponses();
    check('raw_response: rodar de novo não faz nada (idempotente)', n2 === 0);
  }

  // ===== valores de configuração absurdos =====
  {
    const salvo = { ...process.env };
    process.env.AUDIT_LOG_RETENTION_DAYS = '0';
    process.env.RAW_RESPONSE_RETENTION_DAYS = 'abc';
    const c1 = configuration().dataRetention;
    process.env.AUDIT_LOG_RETENTION_DAYS = '-5';
    const c2 = configuration().dataRetention;
    delete process.env.AUDIT_LOG_RETENTION_DAYS;
    delete process.env.RAW_RESPONSE_RETENTION_DAYS;
    const c3 = configuration().dataRetention;
    Object.assign(process.env, salvo);
    check('config: 0, negativo ou texto nunca viram "apagar tudo" (mínimo 1; texto/zero voltam ao padrão)', c1.auditLogDays === 90 && c1.rawResponseDays === 30 && c2.auditLogDays === 1 && c3.auditLogDays === 90 && c3.rawResponseDays === 30, JSON.stringify({ c1, c2, c3 }));
  }

  // ===== 2. concorrência =====
  {
    const mk = (cfgValor: any) => {
      const p: any = new AnalysisProcessor({} as any, { get: () => cfgValor } as any, {} as any, {} as any, {} as any);
      p._worker = { concurrency: 1 };
      p.onApplicationBootstrap();
      return p._worker.concurrency;
    };
    check('worker: aplica ANALYSIS_CONCURRENCY da configuração (5)', mk(5) === 5);
    check('worker: outro valor configurado (8)', mk(8) === 8);
    check('worker: valor inválido (0, NaN, texto) cai no padrão', mk(0) === ANALYSIS_DEFAULT_CONCURRENCY && mk(NaN) === ANALYSIS_DEFAULT_CONCURRENCY && mk('x') === ANALYSIS_DEFAULT_CONCURRENCY);
    check('worker: o padrão é 5', ANALYSIS_DEFAULT_CONCURRENCY === 5 && configuration().analysis.concurrency === 5);
  }

  // ===== 3. polling: leitura da análise só no 'done' =====
  {
    const mkDocs = (status: string) => {
      let leiturasAnalise = 0;
      const db = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: 'd1', user_id: 'u1', status }, error: null }) }) }) }) }) };
      const s = new DocumentsService({ getClient: () => db } as any, {} as any, {} as any, { findByDocument: async () => { leiturasAnalise++; return { id: 'an1' }; } } as any, {} as any);
      return { s, leituras: () => leiturasAnalise };
    };
    for (const st of ['uploaded', 'processing', 'error']) {
      const { s, leituras } = mkDocs(st);
      const r: any = await (s as any).findOneForUser('u1', 'd1');
      check(`polling: status '${st}' não consulta a análise (1 leitura em vez de 2) e devolve analise=null`, leituras() === 0 && r.analise === null);
    }
    const { s, leituras } = mkDocs('done');
    const r: any = await (s as any).findOneForUser('u1', 'd1');
    check("polling: status 'done' devolve a análise", leituras() === 1 && r.analise && r.analise.id === 'an1');
  }

  const ok = resultados.every(Boolean);
  console.log(ok ? `\n✅ ${resultados.length} de ${resultados.length} verificações passaram.` : `\n❌ ${resultados.filter((r) => !r).length} verificação(ões) falharam.`);
  process.exitCode = ok ? 0 : 1;
}
main();
