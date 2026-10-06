/**
 * Teste OFFLINE (sem Redis, Supabase ou IA) do conserto do "documento preso em
 * processing": simula o banco falhando na hora de gravar o status, como numa
 * queda de rede, e confere:
 *   1. gravar 'error' falhando 2x → as tentativas conseguem gravar
 *   2. gravar 'done' falhando 1x  → idem
 *   3. gravar 'error' falhando SEMPRE → o job não lança e o documento fica
 *      'processing' (limite conhecido) ... e a varredura periódica o resgata
 *      depois que passa de ANALYSIS_STUCK_TIMEOUT_MS
 *   4. a varredura só reenfileira o que está de fato parado
 *   5. o handler de 'failed' do BullMQ marca 'error' (com tentativas) e nunca
 *      sobrescreve um 'done'
 */
import { Logger } from '@nestjs/common';
import { AnalysisProcessor } from '../src/analysis/analysis.processor';
import { AnalysisQueueService } from '../src/analysis/analysis-queue.service';

type Row = Record<string, any>;

class FakeDb {
  rows = new Map<string, Row>();
  // quantas gravações de cada status devem falhar antes de funcionar
  failStatusWrites: Record<string, number> = {};
  updateAttempts: Record<string, number> = {};

  add(row: Row) {
    this.rows.set(row.id, { deletado_em: null, tipo: 'pdf', area_negocio: 'juridico', storage_path: 'x.pdf', ...row });
  }

  private filter(filters: Array<(r: Row) => boolean>) {
    return [...this.rows.values()].filter((r) => filters.every((f) => f(r)));
  }

  private builder(
    run: (rows: Row[], state: { wantRows: boolean }) => any,
    filters: Array<(r: Row) => boolean> = [],
    state = { wantRows: false },
  ) {
    const b: any = {
      eq: (c: string, v: unknown) => this.builder(run, [...filters, (r) => r[c] === v], state),
      is: (c: string, v: unknown) => this.builder(run, [...filters, (r) => (r[c] ?? null) === v], state),
      in: (c: string, vs: unknown[]) => this.builder(run, [...filters, (r) => vs.includes(r[c])], state),
      select: () => this.builder(run, filters, { wantRows: true }),
      maybeSingle: async () => ({ data: this.filter(filters)[0] ?? null, error: null }),
      then: (res: any, rej: any) => Promise.resolve(run(this.filter(filters), state)).then(res, rej),
    };
    return b;
  }

  getClient() {
    return {
      from: (table: string) => {
        if (table === 'analyses') return { upsert: async () => ({ error: null }) };
        return {
          select: () => this.builder((rows) => ({ data: rows, error: null })),
          update: (patch: Row) =>
            this.builder((rows, state) => {
              const key = String(patch.status ?? '');
              this.updateAttempts[key] = (this.updateAttempts[key] ?? 0) + 1;
              const restantes = this.failStatusWrites[key] ?? 0;
              if (restantes > 0) {
                this.failStatusWrites[key] = restantes - 1;
                return { error: { message: 'TypeError: fetch failed' } };
              }
              rows.forEach((r) => Object.assign(r, patch));
              return { data: state.wantRows ? rows.map((r) => ({ id: r.id })) : undefined, error: null };
            }),
        };
      },
      storage: {
        from: () => ({
          download: async () => ({ data: { arrayBuffer: async () => new ArrayBuffer(8) }, error: null }),
        }),
      },
    };
  }
}

const config = { get: (k: string) => (k === 'analysis.stuckTimeoutMs' ? 600_000 : 'documents') };
const resultados: boolean[] = [];
const check = (nome: string, ok: boolean, extra = '') => {
  resultados.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${nome}${extra ? ' — ' + extra : ''}`);
};

const outcomeOk = {
  result: { resumo_executivo: 'r', status_compliance_geral: 'conforme', checklist: [], dados_faltantes: [], sugestoes_melhoria: [], aviso_legal: 'a' },
  templateVersao: '1', modelo: 'm', tokensUsados: 1, rawResponse: '{}',
};

function makeProcessor(db: FakeDb, analyze: () => Promise<any>, recover = async (..._a: unknown[]) => {}) {
  const redisFalso = { set: async () => 'OK', incr: async () => 1, expire: async () => 1 };
  const p = new AnalysisProcessor(db as any, config as any, { analyze } as any, { recoverPending: recover } as any, redisFalso as any);
  (p as any).retryBaseMs = 1; // tentativas em milissegundos no teste
  return p;
}
const job = (id: string, name = 'analisar') => ({ name, data: { documentId: id } }) as any;
const minAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

async function main() {
  Logger.overrideLogger(false);

  // 1. análise falha + gravação do 'error' falha 2x
  {
    const db = new FakeDb();
    db.add({ id: 'd1', status: 'uploaded', created_at: minAgo(5) });
    db.failStatusWrites['error'] = 2;
    const p = makeProcessor(db, async () => { throw new Error('IA fora do schema'); });
    await p.process(job('d1'));
    const r = db.rows.get('d1')!;
    check('gravar "error" falhando 2x: as tentativas gravam', r.status === 'error' && /IA fora do schema/.test(r.erro), `status=${r.status}, tentativas=${db.updateAttempts['error']}`);
  }

  // 2. gravação do 'done' falha 1x
  {
    const db = new FakeDb();
    db.add({ id: 'd2', status: 'uploaded', created_at: minAgo(5) });
    db.failStatusWrites['done'] = 1;
    const p = makeProcessor(db, async () => outcomeOk);
    await p.process(job('d2'));
    const r = db.rows.get('d2')!;
    check('gravar "done" falhando 1x: as tentativas gravam', r.status === 'done', `status=${r.status}, tentativas=${db.updateAttempts['done']}`);
  }

  // 3. gravação do 'error' falha SEMPRE → fica 'processing'; a varredura resgata
  {
    const db = new FakeDb();
    db.add({ id: 'd3', status: 'uploaded', created_at: minAgo(5) });
    db.failStatusWrites['error'] = Number.POSITIVE_INFINITY;
    const p = makeProcessor(db, async () => { throw new Error('IA fora do ar'); });
    let lancou = false;
    try { await p.process(job('d3')); } catch { lancou = true; }
    const r = db.rows.get('d3')!;
    check('banco fora o tempo todo: o job não lança e o documento fica "processing" (limite conhecido)', !lancou && r.status === 'processing', `status=${r.status}, tentativas=${db.updateAttempts['error']}`);

    const adds: any[] = [];
    const queue = { add: async (n: string, d: any, o: any) => { adds.push({ n, d, o }); }, upsertJobScheduler: async () => {} };
    const svc = new AnalysisQueueService(queue as any, db as any, config as any);
    await svc.recoverPending(120_000, 'teste');
    check('varredura NÃO mexe no documento recém-parado (ainda dentro do prazo)', adds.length === 0, `reenfileirados: ${adds.length}`);

    r.processing_started_at = minAgo(11); // passa o ANALYSIS_STUCK_TIMEOUT_MS (10 min)
    await svc.recoverPending(120_000, 'teste');
    check('depois do prazo, a varredura reenfileira o documento com jobId = documentId', adds.length === 1 && adds[0].o.jobId === 'd3' && adds[0].n === 'analisar', JSON.stringify(adds.map((a) => a.o.jobId)));
  }

  // 4. a varredura só reenfileira o que está parado
  {
    const db = new FakeDb();
    db.add({ id: 'A-processing-11min', status: 'processing', processing_started_at: minAgo(11), created_at: minAgo(30) });
    db.add({ id: 'B-processing-1min', status: 'processing', processing_started_at: minAgo(1), created_at: minAgo(30) });
    db.add({ id: 'C-uploaded-5min', status: 'uploaded', created_at: minAgo(5) });
    db.add({ id: 'D-uploaded-agora', status: 'uploaded', created_at: new Date(Date.now() - 10_000).toISOString() });
    db.add({ id: 'E-processing-excluido', status: 'processing', processing_started_at: minAgo(20), created_at: minAgo(30), deletado_em: minAgo(1) });
    db.add({ id: 'F-done', status: 'done', created_at: minAgo(30) });
    const ids: string[] = [];
    const queue = { add: async (_n: string, d: any) => { ids.push(d.documentId); }, upsertJobScheduler: async () => {} };
    await new AnalysisQueueService(queue as any, db as any, config as any).recoverPending(120_000, 'teste');
    ids.sort();
    check('varredura reenfileira só A (processing antigo) e C (uploaded antigo)', JSON.stringify(ids) === JSON.stringify(['A-processing-11min', 'C-uploaded-5min']), JSON.stringify(ids));
  }

  // 5. handler de 'failed'
  {
    const db = new FakeDb();
    db.add({ id: 'd5', status: 'processing', created_at: minAgo(5) });
    db.add({ id: 'd6', status: 'done', created_at: minAgo(5) });
    db.failStatusWrites['error'] = 1;
    const p = makeProcessor(db, async () => outcomeOk);
    await p.onJobFailed(job('d5'), new Error('job stalled more than allowable limit'));
    check('handler de "failed": marca "error" com a mensagem (1 falha e nova tentativa)', db.rows.get('d5')!.status === 'error' && /interrompida/.test(db.rows.get('d5')!.erro), `status=${db.rows.get('d5')!.status}`);
    await p.onJobFailed(job('d6'), new Error('qualquer'));
    check('handler de "failed": nunca sobrescreve um documento "done"', db.rows.get('d6')!.status === 'done');
    let ok = true;
    try { await p.onJobFailed(undefined, new Error('x')); } catch { ok = false; }
    check('handler de "failed" sem job não lança', ok);
  }

  // 6. reivindicação condicional do documento (claimForProcessing)
  {
    const claim = async (status: string, extra: Row = {}, failProcessing = 0) => {
      const db = new FakeDb();
      db.add({ id: 'c', status, created_at: minAgo(5), ...extra });
      db.failStatusWrites['processing'] = failProcessing;
      const p = makeProcessor(db, async () => outcomeOk);
      const ganhou = await (p as any).claimForProcessing('c');
      return { ganhou, status: db.rows.get('c')!.status, tentativas: db.updateAttempts['processing'] ?? 0 };
    }
    for (const st of ['uploaded', 'processing']) {
      const r = await claim(st);
      check(`reivindica documento "${st}"`, r.ganhou && r.status === 'processing', `status depois=${r.status}`);
    }
    const erro = await claim('error');
    check('NÃO reivindica documento "error" (estado final: nada o reanalisa)', !erro.ganhou && erro.status === 'error', `status depois=${erro.status}`);
    const done = await claim('done');
    check('NÃO reivindica (nem sobrescreve) documento "done"', !done.ganhou && done.status === 'done', `status depois=${done.status}`);
    const excluido = await claim('uploaded', { deletado_em: minAgo(1) });
    check('NÃO reivindica documento excluído', !excluido.ganhou && excluido.status === 'uploaded');
    const retry = await claim('uploaded', {}, 2);
    check('banco falhando 2x: a reivindicação tenta de novo e consegue', retry.ganhou && retry.tentativas === 3, `tentativas=${retry.tentativas}`);
    const sempre = await claim('uploaded', {}, Number.POSITIVE_INFINITY);
    check('banco fora o tempo todo: não reivindica e não lança', !sempre.ganhou && sempre.status === 'uploaded');
  }

  // 7. a janela real: o documento vira 'done' entre a leitura e a reivindicação
  {
    const db = new FakeDb();
    db.add({ id: 'w', status: 'uploaded', created_at: minAgo(5) });
    let chamouIA = false;
    const p = makeProcessor(db, async () => { chamouIA = true; return outcomeOk; });
    const original = (p as any).loadDocument.bind(p);
    (p as any).loadDocument = async (id: string) => {
      const doc = await original(id);
      db.rows.get(id)!.status = 'done'; // outro worker conclui logo depois da leitura
      return doc;
    };
    await p.process(job('w'));
    check('documento concluído por outro worker entre a leitura e a reivindicação: este job não chama a IA', !chamouIA);
    check('...e o status "done" não é sobrescrito por "processing"', db.rows.get('w')!.status === 'done', `status=${db.rows.get('w')!.status}`);
  }

  // 8. 'error' é terminal e um erro tardio nunca sobrescreve 'done'
  {
    const db = new FakeDb();
    db.add({ id: 'e1', status: 'error', created_at: minAgo(5), erro: 'falhou antes' });
    let chamouIA = false;
    const p = makeProcessor(db, async () => { chamouIA = true; return outcomeOk; });
    await p.process(job('e1'));
    check('job tardio para um documento em "error": não chama a IA nem o reanalisa', !chamouIA && db.rows.get('e1')!.status === 'error');
  }
  {
    // worker "zumbi": falha DEPOIS de outro worker ter concluído o mesmo documento
    const db = new FakeDb();
    db.add({ id: 'z1', status: 'uploaded', created_at: minAgo(5) });
    const p = makeProcessor(db, async () => {
      db.rows.get('z1')!.status = 'done'; // o outro worker conclui enquanto este ainda analisa
      throw new Error('IA fora do ar (worker zumbi)');
    });
    await p.process(job('z1'));
    check('erro de um worker zumbi NÃO sobrescreve o "done" gravado por outro', db.rows.get('z1')!.status === 'done', `status=${db.rows.get('z1')!.status}`);
  }

  const ok = resultados.every(Boolean);
  console.log(ok ? `\n✅ ${resultados.length} de ${resultados.length} verificações passaram.` : `\n❌ ${resultados.filter((r) => !r).length} verificação(ões) falharam.`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.error('FALHA:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
