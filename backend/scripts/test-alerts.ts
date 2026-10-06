/**
 * Teste OFFLINE dos alertas de monitoramento (src/monitoring/alert.service.ts):
 * cada regra, a repetição (cooldown, lembrete), o aviso de "resolvido", os
 * formatos do webhook e o comportamento quando algo falha. Banco, Redis (com
 * relógio simulado), fila e webhook são falsos.
 */
import { Logger } from '@nestjs/common';
import { AlertService, LIMITES } from '../src/monitoring/alert.service';
import { HEARTBEAT_RETENCAO, HEARTBEAT_VARREDURA, MONITOR_INICIO, chaveJobsFalhos } from '../src/monitoring/monitoring.keys';

const resultados: boolean[] = [];
const check = (nome: string, ok: boolean, extra = '') => {
  resultados.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${nome}${extra ? ' — ' + extra : ''}`);
};

// ---- fakes --------------------------------------------------------------------
class FakeRedis {
  store = new Map<string, { v: string; ate: number | null }>();
  offset = 0;
  agora() { return Date.now() + this.offset; }
  avancar(ms: number) { this.offset += ms; }
  private vivo(k: string) { const e = this.store.get(k); if (!e) return null; if (e.ate !== null && e.ate <= this.agora()) { this.store.delete(k); return null; } return e; }
  async get(k: string) { return this.vivo(k)?.v ?? null; }
  async set(k: string, v: string, ...args: any[]) {
    const nx = args.includes('NX');
    const px = args.indexOf('PX') >= 0 ? Number(args[args.indexOf('PX') + 1]) : null;
    if (nx && this.vivo(k)) return null;
    this.store.set(k, { v, ate: px ? this.agora() + px : null });
    return 'OK';
  }
  async del(k: string) { return this.vivo(k) ? (this.store.delete(k), 1) : 0; }
}

type Doc = { status: string; created_at: string; deletado_em: string | null };
function fakeDb(docs: Doc[], estado: { caiu: boolean }) {
  const consulta = () => {
    const f: Array<(d: Doc) => boolean> = [];
    const b: any = {
      is: (c: keyof Doc, v: unknown) => (f.push((d) => (d[c] ?? null) === v), b),
      in: (c: keyof Doc, vs: unknown[]) => (f.push((d) => vs.includes(d[c])), b),
      eq: (c: keyof Doc, v: unknown) => (f.push((d) => d[c] === v), b),
      lt: (c: keyof Doc, v: string) => (f.push((d) => String(d[c]) < v), b),
      gte: (c: keyof Doc, v: string) => (f.push((d) => String(d[c]) >= v), b),
      then: (res: any, rej: any) =>
        Promise.resolve(estado.caiu ? { count: null, error: { message: 'banco fora' } } : { count: docs.filter((d) => f.every((g) => g(d))).length, error: null }).then(res, rej),
    };
    return b;
  };
  return { getClient: () => ({ from: () => ({ select: () => consulta() }) }) };
}

const min = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const doc = (status: string, minutosAtras: number): Doc => ({ status, created_at: min(minutosAtras), deletado_em: null });

interface Cfg { url?: string; formato?: string; cooldown?: number }
function montar(docs: Doc[], opc: Cfg = {}, waiting = 0) {
  const redis = new FakeRedis();
  const estadoBanco = { caiu: false };
  const agendamentos: any[] = [];
  const mon = { upsertJobScheduler: async (...a: any[]) => { agendamentos.push(a); } };
  const fila = { getJobCounts: async () => ({ waiting }) };
  const cfg: Record<string, unknown> = {
    'monitoring.webhookUrl': opc.url ?? 'http://webhook.teste/hook',
    'monitoring.webhookFormat': opc.formato ?? 'slack',
    'monitoring.intervalMs': 60_000,
    'monitoring.cooldownMs': opc.cooldown ?? 1_800_000,
    'analysis.recoveryIntervalMs': 300_000,
  };
  const svc = new AlertService(mon as any, fila as any, fakeDb(docs, estadoBanco) as any, { get: (k: string) => cfg[k] } as any, redis as any);
  // batimentos recentes por padrão: as rotinas estão rodando
  redis.store.set(HEARTBEAT_RETENCAO, { v: String(Date.now()), ate: null });
  redis.store.set(HEARTBEAT_VARREDURA, { v: String(Date.now()), ate: null });
  redis.store.set(MONITOR_INICIO, { v: String(Date.now() - 24 * 3600_000), ate: null });
  return { svc, redis, estadoBanco, agendamentos, docs };
}

const enviados: any[] = [];
let modoWebhook: 'ok' | 'erro500' | 'lanca' = 'ok';
(globalThis as any).fetch = async (_url: string, init: any) => {
  if (modoWebhook === 'lanca') throw new Error('rede fora');
  enviados.push(JSON.parse(init.body));
  return { ok: modoWebhook === 'ok', status: modoWebhook === 'ok' ? 200 : 500 };
};
const limpar = () => { enviados.length = 0; modoWebhook = 'ok'; };
const regra = (rs: any[], id: string) => rs.find((r) => r.id === id);

async function main() {
  Logger.overrideLogger(false);

  // 1. tudo bem
  { limpar(); const t = montar([doc('done', 5)]); const rs = await t.svc.executar();
    check('sistema saudável: nenhuma regra dispara e nada é enviado', rs.every((r) => !r.disparada) && enviados.length === 0); }

  // 2. documento parado -> dispara 1 vez
  { limpar(); const t = montar([doc('processing', 20)]); const rs = await t.svc.executar();
    check('documento pendente há 20 min dispara "documentos parados"', regra(rs, 'documentos_parados').disparada);
    check('o webhook recebe 1 mensagem [CRÍTICO] no formato slack', enviados.length === 1 && /^\[CRÍTICO\] Documentos parados/.test(enviados[0].text), enviados[0]?.text?.slice(0, 60));
    await t.svc.executar();
    check('segunda avaliação dentro do cooldown NÃO repete o alerta', enviados.length === 1);
    t.redis.avancar(1_800_001);
    await t.svc.executar();
    check('depois do cooldown, o alerta que continua é repetido (lembrete)', enviados.length === 2);
    t.docs.length = 0;
    await t.svc.executar();
    check('a condição some: chega 1 aviso [RESOLVIDO]', enviados.length === 3 && /^\[RESOLVIDO\]/.test(enviados[2].text));
    await t.svc.executar();
    check('depois de resolvido, nada mais é enviado', enviados.length === 3); }
  { limpar(); const t = montar([doc('uploaded', 10)]); const rs = await t.svc.executar();
    check('documento pendente há só 10 min NÃO dispara (dentro do prazo)', !regra(rs, 'documentos_parados').disparada && enviados.length === 0); }

  // 3. taxa de erro
  { limpar(); const t = montar([...Array(4).fill(0).map(() => doc('error', 5)), doc('done', 5), doc('done', 5)]); const rs = await t.svc.executar();
    check('4 de 6 análises com erro (67%) dispara "taxa de erro alta"', regra(rs, 'taxa_de_erro_alta').disparada); }
  { limpar(); const t = montar([doc('error', 5), doc('error', 5), doc('done', 5), doc('done', 5)]); const rs = await t.svc.executar();
    check('amostra pequena (4 análises) não dispara, mesmo com 50% de erro', !regra(rs, 'taxa_de_erro_alta').disparada); }
  { limpar(); const t = montar([...Array(3).fill(0).map(() => doc('error', 5)), ...Array(7).fill(0).map(() => doc('done', 5))]); const rs = await t.svc.executar();
    check('3 erros em 10 (30%) não dispara', !regra(rs, 'taxa_de_erro_alta').disparada); }
  { limpar(); const t = montar([...Array(6).fill(0).map(() => doc('error', 40))]); const rs = await t.svc.executar();
    check('erros FORA da janela de 15 min não contam', !regra(rs, 'taxa_de_erro_alta').disparada); }

  // 4. fila
  { limpar(); const t = montar([], {}, LIMITES.filaMaxEspera + 30); const rs = await t.svc.executar();
    check('fila com 80 esperando dispara "fila acumulada" (aviso)', regra(rs, 'fila_acumulada').disparada && /^\[AVISO\]/.test(enviados[0].text)); }
  { limpar(); const t = montar([], {}, 10); const rs = await t.svc.executar();
    check('fila com 10 esperando não dispara', !regra(rs, 'fila_acumulada').disparada); }

  // 5. jobs falhos
  { limpar(); const t = montar([]); t.redis.store.set(chaveJobsFalhos(new Date()), { v: '2', ate: null }); const rs = await t.svc.executar();
    check('contador de jobs falhos > 0 dispara "jobs falhos"', regra(rs, 'jobs_falhos').disparada); }

  // 6. rotinas paradas
  { limpar(); const t = montar([]); t.redis.store.set(HEARTBEAT_RETENCAO, { v: String(Date.now() - 3 * 3600_000), ate: null }); const rs = await t.svc.executar();
    check('retenção sem rodar há 3 h dispara "rotina parada"', regra(rs, 'rotina_retencao_parada').disparada); }
  { limpar(); const t = montar([]); t.redis.store.set(HEARTBEAT_VARREDURA, { v: String(Date.now() - 30 * 60_000), ate: null }); const rs = await t.svc.executar();
    check('varredura sem rodar há 30 min dispara "rotina parada"', regra(rs, 'rotina_varredura_parada').disparada); }
  { limpar(); const t = montar([]); t.redis.store.delete(HEARTBEAT_RETENCAO); t.redis.store.set(MONITOR_INICIO, { v: String(Date.now() - 60_000), ate: null }); const rs = await t.svc.executar();
    check('sem batimento mas o monitoramento começou há 1 min: ainda não alerta', !regra(rs, 'rotina_retencao_parada').disparada); }
  { limpar(); const t = montar([]); t.redis.store.delete(HEARTBEAT_RETENCAO); t.redis.store.set(MONITOR_INICIO, { v: String(Date.now() - 4 * 3600_000), ate: null }); const rs = await t.svc.executar();
    check('sem NENHUM batimento há 4 h (nunca rodou) dispara', regra(rs, 'rotina_retencao_parada').disparada); }

  // 7. banco fora
  { limpar(); const t = montar([doc('processing', 20)]); await t.svc.executar(); enviados.length = 0;
    t.estadoBanco.caiu = true; const rs = await t.svc.executar();
    check('banco fora dispara "banco inacessível"', regra(rs, 'banco_inacessivel').disparada && enviados.some((m) => /Banco de dados inacessível/.test(m.text)));
    check('com o banco fora, as regras que dependem dele ficam "desconhecidas" e NÃO mandam "resolvido"', regra(rs, 'documentos_parados').desconhecida === true && !enviados.some((m) => /RESOLVIDO\] Documentos parados/.test(m.text)));
    enviados.length = 0; t.estadoBanco.caiu = false; await t.svc.executar();
    check('banco volta: "banco inacessível" é resolvido', enviados.some((m) => /RESOLVIDO\] Banco de dados inacessível/.test(m.text))); }

  // 8. formatos e falhas do webhook
  { limpar(); const t = montar([doc('processing', 20)], { formato: 'discord' }); await t.svc.executar();
    check('formato discord usa o campo `content`', typeof enviados[0].content === 'string' && enviados[0].text === undefined); }
  { limpar(); const t = montar([doc('processing', 20)], { formato: 'generic' }); await t.svc.executar();
    check('formato generic manda o JSON completo (estado, regra, severidade)', enviados[0].estado === 'disparado' && enviados[0].regra === 'documentos_parados' && enviados[0].severidade === 'critico'); }
  { limpar(); modoWebhook = 'erro500'; const t = montar([doc('processing', 20)]); let lancou = false;
    try { await t.svc.executar(); } catch { lancou = true; }
    check('webhook respondendo 500 não derruba a avaliação', !lancou); }
  { limpar(); modoWebhook = 'lanca'; const t = montar([doc('processing', 20)]); let lancou = false;
    try { await t.svc.executar(); } catch { lancou = true; }
    check('webhook inalcançável (erro de rede) não derruba a avaliação', !lancou); }
  { limpar(); const t = montar([doc('processing', 20)], { url: '' }); const rs = await t.svc.executar();
    check('sem ALERT_WEBHOOK_URL: avalia e registra no log, sem tentar enviar nada', regra(rs, 'documentos_parados').disparada && enviados.length === 0); }

  // 9. agendamento
  { const t = montar([]); await t.svc.onModuleInit();
    check('registra o job periódico "avaliar-alertas" com o intervalo configurado', t.agendamentos.length === 1 && t.agendamentos[0][0] === 'avaliar-alertas' && t.agendamentos[0][1].every === 60_000); }

  const ok = resultados.every(Boolean);
  console.log(ok ? `\n✅ ${resultados.length} de ${resultados.length} verificações passaram.` : `\n❌ ${resultados.filter((r) => !r).length} verificação(ões) falharam.`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => { console.error('FALHA:', e instanceof Error ? e.stack : e); process.exit(1); });
