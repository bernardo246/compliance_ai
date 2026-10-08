/**
 * Teste AO VIVO da varredura periódica de documentos parados.
 *
 * Pré-requisito: docker compose -f docker-compose.yml -f docker-compose.test.yml up -d --build
 * (3 réplicas, Redis em localhost:6379, varredura a cada 30 s).
 *
 * Cria dois documentos REALMENTE parados, sem nenhum job na fila:
 *   P: 'processing' há 15 min (o worker "morreu" / a gravação do status falhou)
 *   U: 'uploaded' há 10 min (o enqueue se perdeu)
 * e NÃO enfileira nada: quem tem de resgatá-los é o job repetível agendado
 * pelas réplicas. Confere que (1) existe um único scheduler no Redis apesar de
 * 3 réplicas, (2) os dois saem do estado parado e (3) cada um é processado
 * exatamente uma vez.
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
const count = (t: string, n: string) => t.split(n).length - 1;
const minAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const resultados: boolean[] = [];
const check = (nome: string, ok: boolean, extra = '') => {
  resultados.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${nome}${extra ? ' — ' + extra : ''}`);
};

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? 'documents';
  const containers = sh('docker compose ps --format "{{.Name}}" backend').split('\n').map((s) => s.trim()).filter(Boolean);
  if (containers.length < 2) throw new Error('Precisa de pelo menos 2 réplicas.');
  const queue = new Queue('analises', { connection: { url: process.env.REDIS_URL ?? 'redis://localhost:6379' } });

  const P = randomUUID();
  const U = randomUUID();
  const startedAt = new Date().toISOString();
  const paths: string[] = [];
  let userId: string | null = null;

  try {
    const schedulers = await queue.getJobSchedulers();
    const sweep = schedulers.filter((s) => s.key === 'recuperar-pendentes');
    check(
      `um único scheduler "recuperar-pendentes" no Redis apesar de ${containers.length} réplicas`,
      sweep.length === 1 && schedulers.length === 1,
      `schedulers=${schedulers.map((s) => `${s.key}/every=${s.every}`).join(', ')}`,
    );

    const { data: user, error: uErr } = await supabase.from('users')
      .insert({ email: `sweep-test+${P}@example.com`, password_hash: 'x', terms_accepted: true, terms_version: process.env.TERMS_CURRENT_VERSION || '1.1.0' })
      .select('id').single();
    if (uErr) throw new Error(uErr.message);
    userId = user.id;

    const fixture = await readFile(FIXTURE);
    for (const [id, extra] of [
      [P, { status: 'processing', processing_started_at: minAgo(15), created_at: minAgo(20) }],
      [U, { status: 'uploaded', created_at: minAgo(10) }],
    ] as const) {
      const path = `${userId}/${id}-contrato.pdf`;
      paths.push(path);
      const { error: upErr } = await supabase.storage.from(bucket).upload(path, fixture, { contentType: 'application/pdf', upsert: true });
      if (upErr) throw new Error(upErr.message);
      const { error: dErr } = await supabase.from('documents').insert({
        id, user_id: userId, tipo: 'pdf', area_negocio: 'juridico', nome_original: 'contrato.pdf', storage_path: path,
        expira_em: new Date(Date.now() + 72 * 3600 * 1000).toISOString(), ...extra,
      });
      if (dErr) throw new Error(dErr.message);
    }
    console.log(`Documentos parados criados (P=${P.slice(0, 8)} processing, U=${U.slice(0, 8)} uploaded). Nenhum job enfileirado.`);
    console.log('Aguardando o scheduler resgatá-los (varredura a cada 30 s)...');

    const deadline = Date.now() + 6 * 60 * 1000;
    let st: Record<string, string> = {};
    while (Date.now() < deadline) {
      const { data } = await supabase.from('documents').select('id,status').in('id', [P, U]);
      st = Object.fromEntries((data ?? []).map((r) => [r.id, r.status]));
      process.stdout.write(`\r  P=${st[P]} U=${st[U]}   `);
      if ([P, U].every((id) => st[id] === 'done' || st[id] === 'error')) break;
      await sleep(4000);
    }
    console.log();
    check('os dois documentos saíram do estado parado', [P, U].every((id) => st[id] === 'done' || st[id] === 'error'), `P=${st[P]}, U=${st[U]}`);

    const logs = containers.map((c) => { try { return sh(`docker logs --since ${startedAt} ${c} 2>&1`); } catch { return ''; } });
    for (const [nome, id] of [['P', P], ['U', U]] as const) {
      const por = logs.map((l) => count(l, `documento ${id} concluída`) + count(l, `documento ${id} falhou`));
      const total = por.reduce((a, b) => a + b, 0);
      check(`documento ${nome} processado exatamente 1 vez`, total === 1, `por réplica=[${por.join(',')}]`);
    }
    const recuperando = logs.reduce((n, l) => n + count(l, 'varredura periódica'), 0);
    check('o log mostra a recuperação feita pela varredura periódica', recuperando >= 1, `${recuperando} ocorrência(s)`);
  } finally {
    console.log('\nLimpando dados de teste...');
    await supabase.from('analyses').delete().in('document_id', [P, U]);
    await supabase.from('documents').delete().in('id', [P, U]);
    if (paths.length) await supabase.storage.from(bucket).remove(paths);
    if (userId) {
      await supabase.from('audit_logs').delete().eq('user_id', userId);
      await supabase.from('users').delete().eq('id', userId);
    }
    await queue.close();
  }
  const ok = resultados.every(Boolean);
  console.log(ok ? `\n✅ ${resultados.length} de ${resultados.length} verificações passaram.` : `\n❌ ${resultados.filter((r) => !r).length} verificação(ões) falharam.`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.error('\nFalha no teste:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
