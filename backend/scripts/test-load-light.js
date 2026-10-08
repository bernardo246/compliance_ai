// Teste de carga LEVE do fluxo completo (Fase 10): cadastro -> aceite -> upload -> análise pela IA ->
// leitura do resultado, com vários usuários ao mesmo tempo, falando direto com as 3 réplicas do
// Compose. Cada usuário simulado tem um IP próprio (cabeçalho X-Forwarded-For, aceito porque as
// réplicas confiam no proxy), então os limites de taxa por IP valem de verdade (e não é um IP só
// estourando o limite). Mede latência de upload e de leitura, tempo até o resultado final e confere
// que nada fica parado nem devolve 5xx. NÃO é um teste de capacidade: é uma carga de "alguns
// usuários ao mesmo tempo", dentro do que o modelo gratuito de IA aguenta.
//
// Roda DENTRO da rede do Compose (a imagem não leva scripts/ nem fixtures; monta-se as pastas):
//   docker compose -f docker-compose.yml -f docker-compose.test.yml up -d --build
//   docker compose run --rm --no-deps -T -e NODE_PATH=/app/node_modules \
//     -e USERS=8 -e DOCS_PER_USER=2 \
//     -v "$PWD/backend/scripts:/t:ro" -v "$PWD/backend/test-fixtures:/fx:ro" \
//     backend node /t/test-load-light.js
// Apaga tudo (usuários, documentos, análises, arquivos) no fim.
const dns = require('dns').promises;
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const USERS = parseInt(process.env.USERS || '8', 10);
const DOCS_PER_USER = parseInt(process.env.DOCS_PER_USER || '2', 10);
const RAMP_MS = parseInt(process.env.RAMP_MS || '15000', 10); // os usuários chegam espalhados nesse tempo
const MAX_WAIT_MS = parseInt(process.env.MAX_WAIT_MS || String(15 * 60_000), 10);
const VERSION = process.env.TERMS_CURRENT_VERSION || '1.1.0';
const FIXTURES = [
  ['juridico', 'juridico-contrato-com-problemas.pdf'],
  ['financas', 'financas-com-problemas.pdf'],
  ['rh', 'rh-com-problemas.pdf'],
  ['saude', 'saude-bem-estruturado.pdf'],
  ['imobiliario', 'imobiliario-com-problemas.pdf'],
  ['outro', 'outro-com-problemas.pdf'],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
};
const resumo = (arr) => `n=${arr.length} p50=${pct(arr, 50)} ms · p95=${pct(arr, 95)} ms · máx=${arr.length ? Math.max(...arr) : 0} ms`;
// mesma curva do frontend (frontend/src/lib/polling.ts)
const pollDelayMs = (n) => (n < 5 ? 4000 : n < 10 ? 8000 : 15000);

const m = {
  upload: [], leitura: [], lista: [], ready: [], ate_final: [],
  status: {}, // contagem de códigos HTTP por tipo
  falhasRede: 0,
};
const conta = (tipo, status) => { const k = `${tipo}:${status}`; m.status[k] = (m.status[k] || 0) + 1; };

async function call(ip, xff, method, path, { token, json, form, tipo } = {}) {
  const headers = { 'x-forwarded-for': xff };
  if (token) headers.authorization = 'Bearer ' + token;
  let body;
  if (json) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form;
  const t0 = Date.now();
  try {
    const res = await fetch(`http://${ip}:3001${path}`, { method, headers, body });
    let data = null;
    try { data = await res.json(); } catch {}
    const ms = Date.now() - t0;
    if (tipo) conta(tipo, res.status);
    return { status: res.status, data, ms };
  } catch (e) {
    m.falhasRede++;
    return { status: 0, data: null, ms: Date.now() - t0, erro: String(e) };
  }
}

(async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'documents';
  const ips = (await dns.resolve4('backend')).sort();
  console.log(`réplicas: ${ips.length} (${ips.join(', ')}) · ${USERS} usuários × ${DOCS_PER_USER} documentos = ${USERS * DOCS_PER_USER} análises, chegando em ${RAMP_MS / 1000} s`);
  const rep = (i) => ips[i % ips.length];
  const stamp = Date.now();
  const userIds = [];
  const resultados = [];
  const check = (nome, cond, extra = '') => {
    resultados.push(cond);
    console.log(`${cond ? '✅' : '❌'} ${nome}${extra ? ' — ' + extra : ''}`);
  };
  const docs = []; // { id, user, inicio, fim, status }
  let parar = false;

  // amostrador de prontidão enquanto a carga roda
  const sampler = (async () => {
    let i = 0;
    while (!parar) {
      const r = await call(rep(i++), '10.250.0.1', 'GET', '/api/health/ready', { tipo: 'ready' });
      if (r.status) m.ready.push(r.ms);
      await sleep(3000);
    }
  })();

  async function usuario(u) {
    const xff = `10.200.${Math.floor(u / 200)}.${(u % 200) + 1}`;
    const email = `load-light+${stamp}-${u}@example.com`;
    const password = 'Senha-Teste-123!';
    await sleep((RAMP_MS * u) / Math.max(1, USERS));
    const reg = await call(rep(u), xff, 'POST', '/api/auth/register', { json: { email, password }, tipo: 'register' });
    if (reg.status !== 201) return;
    userIds.push(reg.data.user.id);
    const token = reg.data.accessToken;
    const at = await call(rep(u + 1), xff, 'POST', '/api/auth/accept-terms', { token, json: { version: VERSION }, tipo: 'accept' });
    if (at.status !== 200 && at.status !== 201) return;

    const meus = [];
    for (let k = 0; k < DOCS_PER_USER; k++) {
      const [area, arq] = FIXTURES[(u + k) % FIXTURES.length];
      const form = new FormData();
      form.append('file', new Blob([fs.readFileSync('/fx/' + arq)], { type: 'application/pdf' }), `load-${u}-${k}.pdf`);
      form.append('area_negocio', area);
      const up = await call(rep(u + k), xff, 'POST', '/api/documents', { token, form, tipo: 'upload' });
      m.upload.push(up.ms);
      if (up.status === 201) {
        const d = { id: up.data.id, user: u, inicio: Date.now(), fim: null, status: 'uploaded' };
        docs.push(d); meus.push(d);
      }
      await sleep(1500 + Math.random() * 1500);
    }
    // acompanha como o frontend: consulta o documento com intervalo crescente
    let tentativa = 0;
    const limite = Date.now() + MAX_WAIT_MS;
    while (meus.some((d) => !d.fim) && Date.now() < limite) {
      await sleep(pollDelayMs(tentativa++));
      for (const d of meus.filter((x) => !x.fim)) {
        const r = await call(rep(tentativa + d.user), xff, 'GET', '/api/documents/' + d.id, { token, tipo: 'leitura' });
        if (r.status === 200) {
          m.leitura.push(r.ms);
          d.status = r.data.status;
          if (d.status === 'done' || d.status === 'error') { d.fim = Date.now(); m.ate_final.push(d.fim - d.inicio); }
        }
      }
    }
    const l = await call(rep(u), xff, 'GET', '/api/documents', { token, tipo: 'lista' });
    if (l.status === 200) m.lista.push(l.ms);
  }

  const t0 = Date.now();
  try {
    await Promise.all(Array.from({ length: USERS }, (_, u) => usuario(u)));
    parar = true;
    await sampler;
    const dur = Math.round((Date.now() - t0) / 1000);

    const total = docs.length;
    const done = docs.filter((d) => d.status === 'done').length;
    const err = docs.filter((d) => d.status === 'error').length;
    const presos = docs.filter((d) => d.status !== 'done' && d.status !== 'error');
    const c = (pref) => Object.entries(m.status).filter(([k]) => k.startsWith(pref)).map(([k, v]) => `${k.split(':')[1]}×${v}`).join(' ');
    const cincoXX = Object.entries(m.status).filter(([k]) => /:5\d\d$/.test(k)).reduce((a, [, v]) => a + v, 0);
    const quatroVinteNove = Object.entries(m.status).filter(([k]) => /:429$/.test(k)).reduce((a, [, v]) => a + v, 0);

    console.log(`\n===== resultados (${dur} s no total) =====`);
    console.log(`cadastro: ${c('register:')} · aceite: ${c('accept:')} · upload: ${c('upload:')}`);
    console.log(`upload (resposta do POST)      ${resumo(m.upload)}`);
    console.log(`leitura do documento (GET)     ${resumo(m.leitura)}`);
    console.log(`lista de documentos (GET)      ${resumo(m.lista)}`);
    console.log(`/api/health/ready sob carga    ${resumo(m.ready)}`);
    console.log(`do upload ao estado final      ${resumo(m.ate_final.map((x) => Math.round(x)))}`);
    console.log(`documentos: ${total} enviados → done=${done} · error=${err} · presos=${presos.length}`);
    const erros = {};
    for (const d of docs.filter((x) => x.status === 'error')) erros[d.id] = 1;
    if (err) {
      const { data } = await supabase.from('documents').select('erro').in('id', Object.keys(erros));
      const grupos = {};
      for (const r of data || []) grupos[(r.erro || '').slice(0, 90)] = (grupos[(r.erro || '').slice(0, 90)] || 0) + 1;
      console.log('motivos dos erros:', JSON.stringify(grupos));
    }
    console.log();

    check('todos os cadastros e aceites deram certo (IPs distintos, sem 429)', m.status['register:201'] === USERS && quatroVinteNove === 0, `${c('register:')} · 429×${quatroVinteNove}`);
    check('todos os uploads aceitos (201)', total === USERS * DOCS_PER_USER, `${total}/${USERS * DOCS_PER_USER}`);
    check('nenhuma resposta 5xx e nenhuma falha de rede em toda a carga', cincoXX === 0 && m.falhasRede === 0, `5xx=${cincoXX}, rede=${m.falhasRede}`);
    check('nenhum documento ficou preso (todos em done ou error)', presos.length === 0, `${presos.length} preso(s)`);
    check('o upload responde rápido sob carga (p95 < 3 s)', pct(m.upload, 95) < 3000, `p95=${pct(m.upload, 95)} ms`);
    check('a leitura responde rápido sob carga (p95 < 1 s)', pct(m.leitura, 95) < 1000, `p95=${pct(m.leitura, 95)} ms`);
    check('/api/health/ready seguiu respondendo 200 durante toda a carga', (m.status['ready:200'] || 0) === m.ready.length && m.ready.length > 0, c('ready:'));
  } finally {
    parar = true;
    for (const id of userIds) {
      const { data: files } = await supabase.storage.from(bucket).list(id, { limit: 100 });
      if (files && files.length) await supabase.storage.from(bucket).remove(files.map((f) => `${id}/${f.name}`));
      await supabase.from('audit_logs').delete().eq('user_id', id);
      await supabase.from('users').delete().eq('id', id);
    }
    console.log(`limpeza feita (${userIds.length} usuários de teste, documentos, análises e arquivos).`);
  }
  const ok = resultados.length > 0 && resultados.every(Boolean);
  console.log(ok ? `\n✅ ${resultados.length} de ${resultados.length} verificações passaram.` : `\n❌ ${resultados.filter((r) => !r).length} verificação(ões) falharam.`);
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FALHA:', e && e.stack ? e.stack : e); process.exit(1); });
