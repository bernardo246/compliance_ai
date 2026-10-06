/**
 * Cenário: o MESMO job trava duas vezes seguidas (duas réplicas morrem uma
 * depois da outra enquanto processam o mesmo documento).
 *
 * Pré-requisito: `docker compose up` com 3 réplicas + Redis em localhost:6379.
 * Observa o que acontece com o status do documento e com a fila — o
 * BullMQ marca como falho um job que trava mais de `maxStalledCount` vezes.
 * ATENÇÃO: mata 2 das 3 réplicas (restarta no fim).
 */
import 'dotenv/config';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Queue } from 'bullmq';
import { createClient } from '@supabase/supabase-js';

const FIXTURE = join(__dirname, '..', 'test-fixtures', 'juridico-contrato-com-problemas.pdf');
const ROOT = join(__dirname, '..', '..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd: string) => execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const logsOf = (c: string, since: string) => {
  try { return sh(`docker logs --since ${since} ${c} 2>&1`); } catch { return ''; }
};
const count = (t: string, n: string) => t.split(n).length - 1;

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'documents';
  const containers = sh('docker compose ps --format "{{.Name}}" backend').split('\n').map((s) => s.trim()).filter(Boolean);
  if (containers.length < 3) throw new Error('Precisa de 3 réplicas.');
  const queue = new Queue('analises', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379' } });

  const id = randomUUID();
  const startedAt = new Date().toISOString();
  let userId: string | null = null;
  let path: string | null = null;

  try {
    const { data: user, error: uErr } = await supabase.from('users')
      .insert({ email: `stall-test+${id}@example.com`, password_hash: 'x', terms_accepted: true, terms_version: '1.0.0' })
      .select('id').single();
    if (uErr) throw new Error(uErr.message);
    userId = user.id;
    path = `${userId}/${id}-contrato.pdf`;
    await supabase.storage.from(bucket).upload(path, await readFile(FIXTURE), { contentType: 'application/pdf', upsert: true });
    const { error: dErr } = await supabase.from('documents').insert({
      id, user_id: userId, tipo: 'pdf', area_negocio: 'juridico', nome_original: 'contrato.pdf', storage_path: path,
      status: 'uploaded', expira_em: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
    });
    if (dErr) throw new Error(dErr.message);

    await queue.add('analisar', { documentId: id }, { jobId: id, removeOnComplete: true, removeOnFail: true });
    console.log(`Documento ${id.slice(0, 8)} enfileirado.`);

    const killed: string[] = [];
    const deadline = Date.now() + 6 * 60 * 1000;
    while (Date.now() < deadline && killed.length < 2) {
      const { data } = await supabase.from('documents').select('status').eq('id', id).single();
      if (data?.status === 'done' || data?.status === 'error') {
        console.log(`Documento terminou ('${data.status}') antes de matarmos a ${killed.length + 1}ª réplica.`);
        break;
      }
      for (const c of containers) {
        if (killed.includes(c)) continue;
        const l = logsOf(c, startedAt);
        if (count(l, 'Analisando documento') > 0 && count(l, `documento ${id}`) === 0) {
          console.log(`>> matando ${c} (estava com o job) — queda nº ${killed.length + 1}`);
          sh(`docker kill ${c}`);
          killed.push(c);
          break;
        }
      }
      await sleep(1000);
    }

    console.log(`Réplicas mortas: ${killed.length}. Aguardando 120s para ver o que o BullMQ faz...`);
    await sleep(120_000);

    const { data: doc } = await supabase.from('documents').select('status, processing_started_at, erro').eq('id', id).single();
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
    const alive = containers.filter((c) => !killed.includes(c));
    const concluidas = alive.reduce((n, c) => n + count(logsOf(c, startedAt), `documento ${id} concluída`), 0);
    console.log('\n===== RESULTADO =====');
    console.log(`status do documento no banco: ${doc?.status}  (erro: ${doc?.erro ?? 'null'})`);
    console.log(`fila: ${JSON.stringify(counts)}`);
    console.log(`análises concluídas pelas réplicas vivas: ${concluidas}`);
    if (doc?.status === 'done') console.log('✅ O documento foi concluído mesmo após as quedas.');
    else if (doc?.status === 'error' && /interrompida por uma falha no servidor/.test(doc.erro ?? '')) {
      console.log('✅ O job falhou de vez, mas o documento foi marcado como "error" com a mensagem ao usuário (não ficou preso).');
    } else if (doc?.status === 'processing') {
      console.log('❌ DOCUMENTO PRESO em "processing": o job sumiu da fila e nada o recupera sozinho.');
      process.exitCode = 1;
    } else console.log(`ℹ️  Estado final: ${doc?.status}`);
  } finally {
    console.log('\nLimpando dados de teste e religando as réplicas...');
    await supabase.from('analyses').delete().eq('document_id', id);
    await supabase.from('documents').delete().eq('id', id);
    if (path) await supabase.storage.from(bucket).remove([path]);
    if (userId) {
      await supabase.from('audit_logs').delete().eq('user_id', userId);
      await supabase.from('users').delete().eq('id', userId);
    }
    await queue.close();
    try { sh('docker compose start backend'); } catch { /* ignora */ }
  }
}

main().catch((e) => {
  console.error('\nFalha no teste:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
