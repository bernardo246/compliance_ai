// Teste AO VIVO dos alertas de monitoramento (3 réplicas, Redis e Supabase reais).
//
// Pré-requisito: docker compose -f docker-compose.yml -f docker-compose.test.yml up -d --build
// (o override liga o webhook em http://host.docker.internal:9099/hook, avaliação a
// cada 10 s e repetição do mesmo alerta só depois de 60 s).
//
// Sobe um receptor de webhook na porta 9099, cria documentos de verdade parados e com
// erro no Supabase (com a fila de análises PAUSADA, para a varredura não os resgatar),
// e confere: o alerta chega, não se repete dentro do cooldown, e chega o "resolvido"
// quando a condição some. Também confere o batimento da retenção e o endpoint de
// prontidão com o Redis caindo e voltando.
//   node backend/scripts/test-alerts-live.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const http = require('http');
const { execSync } = require('child_process');
const { randomUUID } = require('crypto');
const IORedis = require('ioredis');
const { Queue } = require('bullmq');
const { createClient } = require('@supabase/supabase-js');

const BASE = process.env.LB_URL || 'http://localhost:8080';
const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6379';
const ROOT = require('path').join(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const resultados = [];
const check = (nome, ok, extra = '') => {
  resultados.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${nome}${extra ? ' — ' + extra : ''}`);
};

const recebidos = [];
const servidor = http.createServer((req, res) => {
  let corpo = '';
  req.on('data', (c) => (corpo += c));
  req.on('end', () => {
    try { recebidos.push(JSON.parse(corpo)); } catch {}
    res.writeHead(200).end('ok');
  });
});

async function esperar(cond, ms, passo = 1000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (await cond()) return true;
    await sleep(passo);
  }
  return false;
}
const msgs = (regra, estado) => recebidos.filter((m) => m.regra === regra && m.estado === estado);

async function ready() {
  try {
    const r = await fetch(BASE + '/api/health/ready', { signal: AbortSignal.timeout(8000) });
    return { status: r.status, corpo: await r.json() };
  } catch (e) {
    return { status: 0, corpo: { erro: String(e) } };
  }
}

async function main() {
  await new Promise((r) => servidor.listen(9099, r));
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const redis = new IORedis(REDIS_URL);
  const filaAnalises = new Queue('analises', { connection: { url: REDIS_URL } });
  const filaRetencao = new Queue('retencao', { connection: { url: REDIS_URL } });
  let userId = null;
  const docIds = [];
  const pronto = (n, cond) => cond;

  try {
    await filaAnalises.pause();
    console.log('fila de análises PAUSADA (a varredura não resgata os documentos do teste).');

    const { data: user, error: uErr } = await supabase.from('users')
      .insert({ email: `alerts-live+${Date.now()}@example.com`, password_hash: 'x', terms_accepted: true, terms_version: '1.0.0' })
      .select('id').single();
    if (uErr) throw new Error(uErr.message);
    userId = user.id;
    const base = { user_id: userId, tipo: 'pdf', area_negocio: 'juridico', nome_original: 'alerta.pdf', expira_em: new Date(Date.now() + 72 * 3600e3).toISOString() };
    const minAtras = (m) => new Date(Date.now() - m * 60_000).toISOString();

    // ---- 1. documento parado ---------------------------------------------------------
    const parado = randomUUID();
    docIds.push(parado);
    await supabase.from('documents').insert({ ...base, id: parado, storage_path: `${userId}/${parado}.pdf`, status: 'processing', processing_started_at: minAtras(20), created_at: minAtras(20) });
    const chegou = await esperar(() => msgs('documentos_parados', 'disparado').length >= 1, 45_000);
    check('um documento pendente há 20 min dispara o alerta no webhook (em até 45 s)', chegou);
    const m1 = msgs('documentos_parados', 'disparado')[0];
    check('a mensagem traz regra, severidade crítica e o detalhe', !!m1 && m1.severidade === 'critico' && /documento\(s\) pendente/.test(m1.detalhe), m1 && m1.detalhe);

    await sleep(30_000);
    check('depois de 30 s (3 avaliações) o mesmo alerta NÃO se repete (cooldown de 60 s)', msgs('documentos_parados', 'disparado').length === 1, `${msgs('documentos_parados', 'disparado').length} mensagem(ns)`);

    // ---- 2. taxa de erro alta ----------------------------------------------------------
    for (let i = 0; i < 6; i++) {
      const id = randomUUID();
      docIds.push(id);
      await supabase.from('documents').insert({ ...base, id, storage_path: null, status: 'error', erro: 'teste de alerta', created_at: minAtras(2) });
    }
    const erroChegou = await esperar(() => msgs('taxa_de_erro_alta', 'disparado').length >= 1, 45_000);
    check('6 análises com erro nos últimos minutos disparam "taxa de erro alta"', erroChegou, (msgs('taxa_de_erro_alta', 'disparado')[0] || {}).detalhe);

    // ---- 3. resolvido ---------------------------------------------------------------------
    await supabase.from('documents').delete().in('id', docIds);
    const resolvidos = await esperar(() => msgs('documentos_parados', 'resolvido').length >= 1 && msgs('taxa_de_erro_alta', 'resolvido').length >= 1, 45_000);
    check('quando as condições somem, chegam os avisos de "resolvido" (os dois)', resolvidos);
    const antes = recebidos.length;
    await sleep(25_000);
    check('depois de resolvido, nenhuma mensagem nova chega', recebidos.length === antes, `${recebidos.length - antes} nova(s)`);

    // ---- 4. batimento da retenção ----------------------------------------------------------
    await redis.del('monitor:hb:retencao');
    await filaRetencao.add('purgar', {}, { removeOnComplete: true, removeOnFail: true });
    const bateu = await esperar(async () => !!(await redis.get('monitor:hb:retencao')), 30_000);
    check('o job de retenção registra o batimento no Redis (a rotina "está viva")', bateu);

    // ---- 5. prontidão com o Redis caindo e voltando -----------------------------------------
    const ok0 = await ready();
    check('/api/health/ready responde 200 com Redis e banco ok', ok0.status === 200 && ok0.corpo.redis === 'ok' && ok0.corpo.banco === 'ok', JSON.stringify(ok0.corpo).slice(0, 70));
    execSync('docker compose stop redis', { cwd: ROOT, stdio: 'ignore' });
    await sleep(7000); // passa o cache de 5 s do endpoint
    const fora = await ready();
    check('com o Redis fora, /api/health/ready responde 503 apontando o Redis (e responde, não trava)', fora.status === 503 && fora.corpo.redis === 'falhou', `status ${fora.status}, ${JSON.stringify(fora.corpo).slice(0, 80)}`);
    execSync('docker compose start redis', { cwd: ROOT, stdio: 'ignore' });
    const voltou = await esperar(async () => (await ready()).status === 200, 60_000, 2000);
    check('com o Redis de volta, /api/health/ready volta a 200 sozinho', voltou);
  } finally {
    try { await filaAnalises.resume(); console.log('fila de análises retomada.'); } catch (e) { console.log('ATENÇÃO: não consegui retomar a fila: ' + e.message); }
    if (docIds.length) await supabase.from('documents').delete().in('id', docIds);
    if (userId) {
      await supabase.from('audit_logs').delete().eq('user_id', userId);
      await supabase.from('users').delete().eq('id', userId);
    }
    try { for (const k of await redis.keys('alert:firing:*')) await redis.del(k); } catch {}
    await filaAnalises.close();
    await filaRetencao.close();
    redis.disconnect();
    servidor.close();
    console.log('limpeza feita.');
  }

  const ok = resultados.every(Boolean);
  console.log(ok ? `\n✅ ${resultados.length} de ${resultados.length} verificações passaram.` : `\n❌ ${resultados.filter((r) => !r).length} verificação(ões) falharam.`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.error('FALHA:', e && e.stack ? e.stack : e);
  servidor.close();
  process.exit(1);
});
