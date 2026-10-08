// Teste AO VIVO: o que acontece com a API quando o Redis CAI (3 réplicas atrás do Nginx).
// Antes da correção, todas as rotas travavam (o rate limit esperava o Redis, até o /api/health).
// Agora a API segue respondendo e o rate limit degrada para contadores em memória por réplica.
//
// Pré-requisito: docker compose up -d --build
//   node backend/scripts/test-redis-down-live.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const { execSync } = require('child_process');
const IORedis = require('ioredis');
const { createClient } = require('@supabase/supabase-js');

const BASE = process.env.LB_URL || 'http://localhost:8080';
const ROOT = require('path').join(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const resultados = [];
const check = (nome, ok, extra = '') => { resultados.push(ok); console.log(`${ok ? '✅' : '❌'} ${nome}${extra ? ' — ' + extra : ''}`); };

async function req(method, path, { token, json, ms = 6000 } = {}) {
  const t0 = Date.now();
  try {
    const headers = {};
    if (token) headers.authorization = 'Bearer ' + token;
    if (json) headers['content-type'] = 'application/json';
    const r = await fetch(BASE + path, { method, headers, body: json ? JSON.stringify(json) : undefined, signal: AbortSignal.timeout(ms) });
    let corpo = null; try { corpo = await r.json(); } catch {}
    return { status: r.status, corpo, ms: Date.now() - t0 };
  } catch { return { status: 0, corpo: null, ms: Date.now() - t0 }; }
}

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  let userId = null;
  const redisAdmin = () => new IORedis(process.env.TEST_REDIS_URL || 'redis://localhost:6379', { maxRetriesPerRequest: 1, retryStrategy: () => null, lazyConnect: true });
  try {
    const email = `redis-down+${Date.now()}@example.com`;
    const reg = await req('POST', '/api/auth/register', { json: { email, password: 'Senha-Teste-123!' } });
    userId = reg.corpo.user.id;
    await req('POST', '/api/auth/accept-terms', { token: reg.corpo.accessToken, json: { version: process.env.TERMS_CURRENT_VERSION || '1.1.0' } });
    const token = reg.corpo.accessToken;
    check('antes da queda: GET /api/documents responde 200', (await req('GET', '/api/documents', { token })).status === 200);

    execSync('docker compose stop redis', { cwd: ROOT, stdio: 'ignore' });
    console.log('>> Redis PARADO');
    await sleep(4000);

    const login = await req('POST', '/api/auth/login', { json: { email: 'nao-existe@example.com', password: 'x' } });
    check('login (que usa o rate limit) responde 401 normalmente, sem travar', login.status === 401 && login.ms < 3000, `status ${login.status} em ${login.ms} ms`);
    const health = await req('GET', '/api/health');
    check('/api/health (o healthcheck do container) responde 200', health.status === 200 && health.ms < 3000, `status ${health.status} em ${health.ms} ms`);
    const ready = await req('GET', '/api/health/ready');
    check('/api/health/ready responde 503 apontando o Redis', ready.status === 503 && ready.corpo && ready.corpo.redis === 'falhou', `status ${ready.status}`);
    const docs = await req('GET', '/api/documents', { token });
    check('GET /api/documents com login responde 200 (o cache de termos cai para o banco)', docs.status === 200 && docs.ms < 4000, `status ${docs.status} em ${docs.ms} ms`);

    const codigos = [];
    for (let i = 0; i < 20; i++) codigos.push((await req('POST', '/api/auth/login', { json: { email: 'nao-existe@example.com', password: 'x' } })).status);
    const primeiro429 = codigos.indexOf(429);
    check('o rate limit continua valendo, por réplica (429 aparece em até 16 tentativas com 3 réplicas)', primeiro429 > 0 && primeiro429 <= 16, `429 na tentativa ${primeiro429 + 1}; status: ${codigos.join(' ')}`);

    execSync('docker compose start redis', { cwd: ROOT, stdio: 'ignore' });
    console.log('>> Redis DE VOLTA');
    let voltou = false;
    for (let i = 0; i < 40 && !voltou; i++) { await sleep(2000); voltou = (await req('GET', '/api/health/ready')).status === 200; }
    check('com o Redis de volta, /api/health/ready volta a 200', voltou);

    await sleep(65_000); // deixa o bloqueio em memória de 60 s das réplicas expirar
    const depois = await req('POST', '/api/auth/login', { json: { email: 'nao-existe@example.com', password: 'x' } });
    const r = redisAdmin();
    await r.connect();
    const chaves = (await r.keys('*')).filter((k) => /hits/.test(k)).length;
    r.disconnect();
    check('depois da volta, o login funciona e o contador do rate limit voltou a ser gravado no Redis', depois.status === 401 && chaves > 0, `status ${depois.status}, ${chaves} chave(s) de rate limit no Redis`);
  } finally {
    try { execSync('docker compose start redis', { cwd: ROOT, stdio: 'ignore' }); } catch {}
    if (userId) {
      await supabase.from('audit_logs').delete().eq('user_id', userId);
      await supabase.from('users').delete().eq('id', userId);
    }
    console.log('limpeza feita.');
  }
  const ok = resultados.every(Boolean);
  console.log(ok ? `\n✅ ${resultados.length} de ${resultados.length} verificações passaram.` : `\n❌ ${resultados.filter((r) => !r).length} verificação(ões) falharam.`);
  process.exitCode = ok ? 0 : 1;
}
main().catch((e) => { console.error('FALHA:', e && e.stack ? e.stack : e); process.exit(1); });
