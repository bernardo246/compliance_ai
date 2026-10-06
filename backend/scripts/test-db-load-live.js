// Teste AO VIVO (Supabase e Redis reais, 3 réplicas atrás do Nginx) das mudanças que
// tiram carga do banco:
//   1. cache do aceite dos termos: a chave aparece no Redis depois de requisições
//      a /api/documents, e quem não aceitou o termo toma 403 e não é guardado
//   2. limpeza de refresh tokens expirados: 250 expirados + 5 válidos no banco,
//      o job de retenção é disparado pela fila e só os expirados somem
//
// Pré-requisito: docker compose -f docker-compose.yml -f docker-compose.test.yml up -d --build
//   node backend/scripts/test-db-load-live.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const { randomUUID, randomBytes } = require('crypto');
const IORedis = require('ioredis');
const { Queue } = require('bullmq');
const { createClient } = require('@supabase/supabase-js');

const BASE = process.env.LB_URL || 'http://localhost:8080';
const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6379';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const resultados = [];
const check = (nome, ok, extra = '') => {
  resultados.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${nome}${extra ? ' — ' + extra : ''}`);
};

async function http(method, path, { token, json } = {}) {
  const headers = {};
  let body;
  if (token) headers.authorization = 'Bearer ' + token;
  if (json) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const res = await fetch(BASE + path, { method, headers, body });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const redis = new IORedis(REDIS_URL);
  const queue = new Queue('retencao', { connection: { url: REDIS_URL } });
  const userIds = [];
  const stamp = Date.now();

  try {
    // ---- 1. cache dos termos ---------------------------------------------------
    const aceito = await http('POST', '/api/auth/register', { json: { email: `dbload-ok+${stamp}@example.com`, password: 'Senha-Teste-123!' } });
    userIds.push(aceito.data.user.id);
    await http('POST', '/api/auth/accept-terms', { token: aceito.data.accessToken, json: { version: process.env.TERMS_CURRENT_VERSION || '1.0.0' } });

    const antes = await redis.keys(`terms:ok:${aceito.data.user.id}:*`);
    const codigos = [];
    for (let i = 0; i < 5; i++) codigos.push((await http('GET', '/api/documents', { token: aceito.data.accessToken })).status);
    const depois = await redis.keys(`terms:ok:${aceito.data.user.id}:*`);
    const ttl = depois.length ? await redis.ttl(depois[0]) : -2;
    check('antes da 1ª requisição de documentos não há chave de cache', antes.length === 0);
    check('5 requisições a /api/documents respondem 200', codigos.every((c) => c === 200), codigos.join(' '));
    check('a chave `terms:ok:<usuário>:<versão>` aparece no Redis com validade (TTL)', depois.length === 1 && ttl > 0 && ttl <= 300, `chave=${depois[0]}, ttl=${ttl}s`);

    const recusado = await http('POST', '/api/auth/register', { json: { email: `dbload-no+${stamp}@example.com`, password: 'Senha-Teste-123!' } });
    userIds.push(recusado.data.user.id);
    const bloqueios = [];
    for (let i = 0; i < 3; i++) bloqueios.push((await http('GET', '/api/documents', { token: recusado.data.accessToken })).status);
    const chaveRecusado = await redis.keys(`terms:ok:${recusado.data.user.id}:*`);
    check('quem não aceitou o termo toma 403 sempre e NÃO vira cache', bloqueios.every((c) => c === 403) && chaveRecusado.length === 0, bloqueios.join(' '));

    // ---- 2. limpeza de refresh tokens expirados ---------------------------------------
    const dono = aceito.data.user.id;
    const passado = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const futuro = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const expirados = Array.from({ length: 250 }, () => ({ user_id: dono, token_hash: randomBytes(32).toString('hex'), expires_at: passado, revoked: true }));
    const validos = Array.from({ length: 5 }, () => ({ user_id: dono, token_hash: randomBytes(32).toString('hex'), expires_at: futuro, revoked: false }));
    const ins = await supabase.from('refresh_tokens').insert([...expirados, ...validos]);
    if (ins.error) throw new Error('insert refresh_tokens: ' + ins.error.message);

    const contar = async (filtro) => {
      const q = supabase.from('refresh_tokens').select('id', { count: 'exact', head: true }).eq('user_id', dono);
      const { count } = await (filtro === 'expirados' ? q.lt('expires_at', new Date().toISOString()) : q.gt('expires_at', new Date().toISOString()));
      return count;
    };
    const exp0 = await contar('expirados');
    const val0 = await contar('validos');
    console.log(`   antes do job: ${exp0} expirados, ${val0} válidos`);

    await queue.add('purgar', {}, { removeOnComplete: true, removeOnFail: true });
    let exp1 = exp0;
    for (let i = 0; i < 40 && exp1 > 0; i++) { await sleep(1500); exp1 = await contar('expirados'); }
    const val1 = await contar('validos');
    console.log(`   depois do job: ${exp1} expirados, ${val1} válidos`);
    check('o job de retenção apagou todos os 250 tokens expirados (em lotes, pelo PostgREST real)', exp0 >= 250 && exp1 === 0);
    check('os tokens ainda válidos foram preservados', val1 === val0 && val1 >= 5, `${val1} válidos`);
  } finally {
    for (const id of userIds) {
      await supabase.from('audit_logs').delete().eq('user_id', id);
      await supabase.from('users').delete().eq('id', id);
      for (const k of await redis.keys(`terms:ok:${id}:*`)) await redis.del(k);
    }
    await queue.close();
    await redis.quit();
    console.log('limpeza feita (usuários de teste, tokens e chaves de cache).');
  }

  const ok = resultados.every(Boolean);
  console.log(ok ? `\n✅ ${resultados.length} de ${resultados.length} verificações passaram.` : `\n❌ ${resultados.filter((r) => !r).length} verificação(ões) falharam.`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.error('FALHA:', e && e.stack ? e.stack : e);
  process.exit(1);
});
