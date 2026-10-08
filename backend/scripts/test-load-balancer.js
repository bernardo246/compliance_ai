// Teste do load balancer (Nginx) na frente das réplicas — Fase 8.
//
// Pré-requisito (na raiz do repo): docker compose up -d --build
// Roda no HOST, falando só com o Nginx em http://localhost:8080:
//   node backend/scripts/test-load-balancer.js
//
// Cria um usuário de teste (cenário "dois dispositivos") e apaga tudo no fim.
// ATENÇÃO: mata e recria réplicas (docker compose) durante o teste.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const BASE = process.env.LB_URL || 'http://localhost:8080';
const ROOT = path.join(__dirname, '..', '..');
const FIXTURE = path.join(__dirname, '..', 'test-fixtures', 'juridico-contrato-com-problemas.pdf');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sh = (cmd) => execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const results = [];
const check = (nome, cond, extra = '') => {
  results.push(cond);
  console.log(`${cond ? '✅' : '❌'} ${nome}${extra ? ' — ' + extra : ''}`);
};

async function http(method, p, { token, json, form, headers = {}, cookie } = {}) {
  const h = { ...headers };
  if (token) h.authorization = 'Bearer ' + token;
  if (cookie) h.cookie = cookie;
  let body;
  if (json) {
    h['content-type'] = 'application/json';
    body = JSON.stringify(json);
  }
  if (form) body = form;
  const res = await fetch(BASE + p, { method, headers: h, body });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const refresh = setCookie.map((c) => c.split(';')[0]).find((c) => c.startsWith('refresh_token='));
  return { status: res.status, data, refreshCookie: refresh };
}

const distribuicao = (instances) => {
  const c = {};
  instances.forEach((i) => (c[i] = (c[i] || 0) + 1));
  return c;
};

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'documents';
  let userId = null;

  try {
    // ---- 1. Nginx no ar -----------------------------------------------------
    const h = await fetch(BASE + '/nginx-health');
    check('Nginx responde em ' + BASE, h.status === 200);

    // ---- 2. Distribuição entre réplicas + estado compartilhado ---------------
    const N = 150;
    const r1 = [];
    for (let i = 0; i < N; i++) r1.push(await http('GET', '/api/debug/instance'));
    const todos200 = r1.every((r) => r.status === 200 && r.data && r.data.instanceId);
    check(`${N} requisições, todas respondidas com 200`, todos200, `status distintos: ${[...new Set(r1.map((r) => r.status))].join(',')}`);
    const dist = distribuicao(r1.map((r) => r.data && r.data.instanceId));
    const qtd = Object.values(dist);
    check(
      'requisições repartidas pelas 3 réplicas (cada uma recebe pelo menos 20%)',
      Object.keys(dist).length === 3 && Math.min(...qtd) >= N * 0.2,
      `distribuição: ${JSON.stringify(Object.values(dist))}`,
    );
    const hits = r1.map((r) => r.data && r.data.hits);
    const sequencial = hits.every((v, i) => typeof v === 'number' && (i === 0 || v === hits[i - 1] + 1));
    check('contador no Redis cresce sem repetir, qualquer que seja a réplica', sequencial, `de ${hits[0]} a ${hits[N - 1]}`);

    // ---- 3. IP real do cliente (TRUST_PROXY) e header forjado ---------------
    const ipNormal = (await http('GET', '/api/debug/instance')).data.ip;
    const ipForjado = (await http('GET', '/api/debug/instance', { headers: { 'x-forwarded-for': '6.6.6.6' } })).data.ip;
    const nginxIp = sh("docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' compliance-nginx-1").trim();
    check(
      'backend enxerga o IP de quem conectou ao Nginx (e não o IP do próprio Nginx)',
      !!ipNormal && ipNormal !== nginxIp,
      `ip visto pelo backend=${ipNormal}, IP do container Nginx=${nginxIp}`,
    );
    check('cliente NÃO consegue forjar o IP mandando X-Forwarded-For', !!ipForjado && ipForjado !== '6.6.6.6' && ipForjado === ipNormal, `com header forjado ip=${ipForjado}`);

    // ---- 4. Limite de upload (Nginx não pode barrar antes do backend) -------
    const big = new FormData();
    big.append('file', new Blob([Buffer.alloc(5 * 1024 * 1024, 1)], { type: 'application/pdf' }), 'grande.pdf');
    big.append('area_negocio', 'juridico');
    const up = await http('POST', '/api/documents', { form: big });
    check('upload de 5 MB passa pelo Nginx (resposta vem do backend: 401, não 413)', up.status === 401, `status ${up.status}`);

    // ---- 5. Dois dispositivos, mesma conta ----------------------------------
    const email = `lb-test+${Date.now()}@example.com`;
    const password = 'Senha-Teste-123!';
    const reg = await http('POST', '/api/auth/register', { json: { email, password } });
    userId = reg.data && reg.data.user && reg.data.user.id;
    const terms = await http('POST', '/api/auth/accept-terms', {
      token: reg.data.accessToken,
      json: { version: process.env.TERMS_CURRENT_VERSION || '1.1.0' },
    });
    const loginB = await http('POST', '/api/auth/login', { json: { email, password } });
    const tokenA = reg.data.accessToken;
    const tokenB = loginB.data.accessToken;
    check('dispositivo A (cadastro) e B (login) com a mesma conta', reg.status === 201 && terms.status === 200 && loginB.status === 200);

    const pdf = fs.readFileSync(FIXTURE);
    const mk = (nome) => {
      const f = new FormData();
      f.append('file', new Blob([pdf], { type: 'application/pdf' }), nome);
      f.append('area_negocio', 'juridico');
      return f;
    };
    const ups = await Promise.all([
      http('POST', '/api/documents', { token: tokenA, form: mk('a1.pdf') }),
      http('POST', '/api/documents', { token: tokenB, form: mk('b1.pdf') }),
      http('POST', '/api/documents', { token: tokenA, form: mk('a2.pdf') }),
      http('POST', '/api/documents', { token: tokenB, form: mk('b2.pdf') }),
    ]);
    check('4 uploads simultâneos (2 de cada dispositivo)', ups.every((u) => u.status === 201), `status: ${ups.map((u) => u.status).join(' ')}`);
    const docIds = ups.filter((u) => u.status === 201).map((u) => u.data.id);

    const listaA = (await http('GET', '/api/documents', { token: tokenA })).data || [];
    const listaB = (await http('GET', '/api/documents', { token: tokenB })).data || [];
    const vistoPorAmbos = docIds.every((id) => listaA.some((d) => d.id === id) && listaB.some((d) => d.id === id));
    check('os dois dispositivos enxergam os 4 documentos', vistoPorAmbos, `A vê ${listaA.length}, B vê ${listaB.length}`);

    const del = await http('DELETE', '/api/documents/' + docIds[0], { token: tokenB });
    const aposA = await http('GET', '/api/documents/' + docIds[0], { token: tokenA });
    check(
      'B exclui um documento enviado por A; A passa a ver o documento como excluído',
      del.status < 300 && aposA.status === 200 && !!aposA.data.deletado_em && aposA.data.storage_path === null,
      `delete ${del.status}; GET de A: status ${aposA.status}, deletado_em=${aposA.data && aposA.data.deletado_em ? 'preenchido' : 'vazio'}, storage_path=${aposA.data && aposA.data.storage_path}, corpo=${JSON.stringify(aposA.data).slice(0, 120)}`,
    );

    const logoutA = await http('POST', '/api/auth/logout', { token: tokenA, cookie: reg.refreshCookie });
    const refreshB = await http('POST', '/api/auth/refresh', { cookie: loginB.refreshCookie });
    check('logout em A não derruba a sessão de B (refresh de B continua válido)', logoutA.status === 200 && refreshB.status === 200, `logout A ${logoutA.status}, refresh B ${refreshB.status}`);

    // ---- 6. Rate limit global através do LB ---------------------------------
    // (login tem limite de 5/min por IP; já gastamos 1 login acima e o
    // cadastro tem bucket próprio, então o limite deve estourar cedo)
    const codes = [];
    for (let i = 0; i < 9; i++) {
      codes.push((await http('POST', '/api/auth/login', { json: { email: 'x@x.com', password: 'errada-123' } })).status);
    }
    const primeiro429 = codes.indexOf(429);
    check('rate limit de login vale somado entre as réplicas (429 após poucas tentativas)', primeiro429 > 0 && primeiro429 <= 5, `status: ${codes.join(' ')}`);

    // ---- 7. Uma réplica cai com tráfego rodando -----------------------------
    const nomes = sh('docker compose ps --format "{{.Name}}" backend').split('\n').map((s) => s.trim()).filter(Boolean);
    sh(`docker kill ${nomes[0]}`);
    console.log(`>> matei ${nomes[0]}; mandando 60 requisições logo em seguida...`);
    const apos = [];
    for (let i = 0; i < 60; i++) {
      try {
        apos.push((await http('GET', '/api/debug/instance')).status);
      } catch {
        apos.push('erro-de-conexão');
      }
    }
    const falhas = apos.filter((s) => s !== 200).length;
    check('com uma réplica morta, o Nginx segue respondendo', falhas <= 3, `${falhas} falha(s) em 60 requisições (status distintos: ${[...new Set(apos)].join(',')})`);
    sh('docker compose start backend');

    // ---- 8. Escalar para 5 réplicas sem reiniciar o Nginx -------------------
    console.log('>> escalando para 5 réplicas (sem reiniciar o Nginx)...');
    sh('docker compose up -d --no-recreate --scale backend=5 backend');
    const limite = Date.now() + 120000;
    while (Date.now() < limite) {
      const saudaveis = sh('docker compose ps backend --format "{{.Health}}"').split('\n').filter((l) => l.trim() === 'healthy').length;
      if (saudaveis >= 5) break;
      await sleep(3000);
    }
    await sleep(7000); // passa o valid=5s do resolver do Nginx
    const r5 = [];
    for (let i = 0; i < 150; i++) r5.push((await http('GET', '/api/debug/instance')).data);
    const dist5 = distribuicao(r5.map((r) => r && r.instanceId));
    check('o Nginx passa a usar as 5 réplicas sem ser reiniciado', Object.keys(dist5).length === 5, `distribuição: ${JSON.stringify(Object.values(dist5))}`);

    // ---- espera as análises dos 4 uploads antes de limpar -------------------
    console.log('Aguardando as análises dos documentos de teste terminarem (até 4 min)...');
    const fim = Date.now() + 4 * 60 * 1000;
    while (Date.now() < fim) {
      const { data } = await supabase.from('documents').select('status').in('id', docIds);
      if (data && data.every((d) => d.status === 'done' || d.status === 'error')) break;
      await sleep(5000);
    }
  } finally {
    if (userId) {
      const { data: files } = await supabase.storage.from(bucket).list(userId, { limit: 100 });
      if (files && files.length) await supabase.storage.from(bucket).remove(files.map((f) => `${userId}/${f.name}`));
      await supabase.from('audit_logs').delete().eq('user_id', userId);
      await supabase.from('users').delete().eq('id', userId);
      console.log('limpeza feita (usuário, documentos, análises e arquivos de teste).');
    }
    try {
      sh('docker compose up -d --no-recreate --scale backend=3 backend');
    } catch {}
  }

  const ok = results.every(Boolean);
  console.log(ok ? '\n✅ Todas as verificações passaram.' : `\n❌ ${results.filter((r) => !r).length} verificação(ões) falharam.`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.error('\nFALHA:', e && e.stack ? e.stack : e);
  process.exit(1);
});
