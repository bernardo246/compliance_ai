/**
 * Teste de race condition da fila de análise (BullMQ) com VÁRIAS réplicas.
 *
 * Pré-requisito: `docker compose up` com 3 réplicas do backend E o Redis do
 * Compose exposto em localhost:6379 (override temporário de portas).
 *
 * Cenário A (rajada): 6 documentos, cada um enfileirado 15x ao mesmo tempo
 *   por 3 produtores independentes (conexões separadas, como 3 réplicas
 *   recebendo uploads). Esperado: cada documento processado EXATAMENTE 1 vez
 *   (conferido nos logs das réplicas), 1 linha em `analyses` por documento.
 * Cenário B (replay): depois de tudo 'done', enfileira de novo cada documento.
 *   Esperado: nenhuma análise nova (o worker ignora documentos já 'done').
 * Cenário C (--kill): mata uma réplica no meio de uma análise. Esperado: o
 *   job travado é retomado por outra réplica e todos os documentos terminam.
 */
import 'dotenv/config';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Queue } from 'bullmq';
import { createClient } from '@supabase/supabase-js';

const N_DOCS = parseInt(process.env.N_DOCS ?? '6', 10);
const DUPLICATES = 15;
const PRODUCERS = 3;
const KILL = process.argv.includes('--kill');
const FIXTURE = join(__dirname, '..', 'test-fixtures', 'juridico-contrato-com-problemas.pdf');
const ROOT = join(__dirname, '..', '..');
const TIMEOUT_MS = 10 * 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd: string) => execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function replicas(): string[] {
  return sh('docker compose ps --format "{{.Name}}" backend').split('\n').map((s) => s.trim()).filter(Boolean);
}
function logsOf(container: string, since: string): string {
  try {
    return sh(`docker logs --since ${since} ${container} 2>&1`);
  } catch {
    return '';
  }
}
const count = (text: string, needle: string) => text.split(needle).length - 1;

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'documents';
  const fixture = await readFile(FIXTURE);
  const containers = replicas();
  console.log(`Réplicas: ${containers.join(', ')}`);
  if (containers.length < 2) throw new Error('Precisa de pelo menos 2 réplicas rodando.');

  const queues = Array.from(
    { length: PRODUCERS },
    () => new Queue('analises', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379' } }),
  );
  const enqueue = (q: Queue, id: string) =>
    q.add('analisar', { documentId: id }, { jobId: id, removeOnComplete: true, removeOnFail: true });

  const runId = randomUUID();
  const docIds = Array.from({ length: N_DOCS }, () => randomUUID());
  const paths: string[] = [];
  let userId: string | null = null;
  const startedAt = new Date().toISOString();

  try {
    const { data: user, error: uErr } = await supabase
      .from('users')
      .insert({ email: `race-test+${runId}@example.com`, password_hash: 'x', terms_accepted: true, terms_version: '1.0.0' })
      .select('id')
      .single();
    if (uErr) throw new Error(`Falha ao criar usuário: ${uErr.message}`);
    userId = user.id;

    for (const id of docIds) {
      const path = `${userId}/${id}-contrato.pdf`;
      paths.push(path);
      const { error: upErr } = await supabase.storage.from(bucket).upload(path, fixture, { contentType: 'application/pdf', upsert: true });
      if (upErr) throw new Error(`Upload: ${upErr.message}`);
      const { error: dErr } = await supabase.from('documents').insert({
        id, user_id: userId, tipo: 'pdf', area_negocio: 'juridico', nome_original: 'contrato.pdf',
        storage_path: path, status: 'uploaded', expira_em: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
      });
      if (dErr) throw new Error(`Insert documents: ${dErr.message}`);
    }
    console.log(`${N_DOCS} documentos criados. Disparando ${N_DOCS * DUPLICATES} enqueues simultâneos...`);

    // ---- Cenário A: rajada ------------------------------------------------
    const adds: Promise<unknown>[] = [];
    for (let d = 0; d < DUPLICATES; d++) {
      for (const id of docIds) adds.push(enqueue(queues[(d + adds.length) % PRODUCERS], id));
    }
    await Promise.all(adds);
    console.log('Rajada enviada.');

    let killed = '';
    const deadline = Date.now() + TIMEOUT_MS;
    let statuses: Record<string, string> = {};
    while (Date.now() < deadline) {
      const { data } = await supabase.from('documents').select('id,status').in('id', docIds);
      statuses = Object.fromEntries((data ?? []).map((r) => [r.id, r.status]));
      const vals = Object.values(statuses);
      if (KILL && !killed && vals.includes('processing')) {
        for (const c of containers) {
          if (count(logsOf(c, startedAt), 'Analisando documento') > 0) {
            killed = c;
            console.log(`>> Cenário C: matando ${c} no meio de uma análise.`);
            sh(`docker kill ${c}`);
            break;
          }
        }
      }
      process.stdout.write(`\r  status: ${JSON.stringify(vals.reduce((a: Record<string, number>, s) => ((a[s] = (a[s] ?? 0) + 1), a), {}))}   `);
      if (vals.every((s) => s === 'done' || s === 'error')) break;
      await sleep(3000);
    }
    console.log();

    const survivors = containers.filter((c) => c !== killed);
    const allLogs = Object.fromEntries(containers.map((c) => [c, logsOf(c, startedAt)]));

    console.log('\n===== RESULTADO: processamentos por documento (logs das réplicas) =====');
    let duplicated = 0;
    for (const id of docIds) {
      const per = containers.map(
        (c) =>
          count(allLogs[c], `Análise do documento ${id} concluída`) +
          count(allLogs[c], `Análise do documento ${id} falhou`),
      );
      const total = per.reduce((a, b) => a + b, 0);
      if (total > 1) duplicated++;
      console.log(`${id.slice(0, 8)}  status=${statuses[id]}  processamentos=${total}  por réplica=[${per.join(',')}]`);
    }
    const { data: rows } = await supabase.from('analyses').select('document_id').in('document_id', docIds);
    const perDoc: Record<string, number> = {};
    (rows ?? []).forEach((r) => (perDoc[r.document_id] = (perDoc[r.document_id] ?? 0) + 1));
    const dupRows = Object.values(perDoc).filter((n) => n > 1).length;

    console.log('\nCarga por réplica (análises iniciadas):');
    containers.forEach((c) => console.log(`  ${c}: ${count(allLogs[c], 'Analisando documento')}${c === killed ? '  (morta no teste)' : ''}`));

    const doneCount = Object.values(statuses).filter((s) => s === 'done').length;
    const errors = Object.values(statuses).filter((s) => s === 'error').length;
    console.log(`\ndone=${doneCount}  error=${errors}  linhas em analyses=${rows?.length ?? 0}  documentos processados mais de 1x=${duplicated}  linhas duplicadas em analyses=${dupRows}`);

    // ---- Cenário B: replay após 'done' ------------------------------------
    const doneIds = docIds.filter((id) => statuses[id] === 'done');
    if (doneIds.length > 0 && !KILL) {
      const antes = containers.reduce((n, c) => n + count(logsOf(c, startedAt), 'Analisando documento'), 0);
      console.log(`\nCenário B: re-enfileirando os ${doneIds.length} documentos já concluídos (3x cada)...`);
      await Promise.all(doneIds.flatMap((id) => [0, 1, 2].map((i) => enqueue(queues[i % PRODUCERS], id))));
      await sleep(20000);
      const depois = containers.reduce((n, c) => n + count(logsOf(c, startedAt), 'Analisando documento'), 0);
      console.log(`  análises iniciadas antes=${antes} depois=${depois} → ${depois === antes ? '✅ nenhuma reanálise' : '❌ REANALISOU documentos já concluídos'}`);
      if (depois !== antes) process.exitCode = 1;
    }

    const counts = await queues[0].getJobCounts('waiting', 'active', 'delayed', 'failed');
    console.log(`\nFila ao final: ${JSON.stringify(counts)}`);

    const terminais = doneCount + errors === N_DOCS;
    if (errors > 0) console.log(`(${errors} documento(s) em 'error': falha da IA/OpenRouter, não é race — cada um foi processado 1x.)`);
    const ok = duplicated === 0 && dupRows === 0 && terminais;
    console.log(ok ? '\n✅ Sem race condition: nenhum documento processado em duplicidade (e todos chegaram a um estado final).' : '\n❌ Problema detectado (ver números acima).');
    if (!ok) process.exitCode = 1;
    void survivors;
  } finally {
    console.log('\nLimpando dados de teste...');
    await supabase.from('analyses').delete().in('document_id', docIds);
    await supabase.from('documents').delete().in('id', docIds);
    if (paths.length) await supabase.storage.from(bucket).remove(paths);
    if (userId) {
      await supabase.from('audit_logs').delete().eq('user_id', userId);
      await supabase.from('users').delete().eq('id', userId);
    }
    await Promise.all(queues.map((q) => q.close()));
  }
}

main().catch((err) => {
  console.error('\nFalha no teste:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
