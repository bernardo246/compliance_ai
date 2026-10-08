// Teste ponta a ponta pela API HTTP real, falando direto com o IP de cada réplica.
// Roda DENTRO da rede do Compose (a imagem não leva scripts/, então monta-se a pasta):
//   docker compose run --rm --no-deps -T -e NODE_PATH=/app/node_modules \
//     -v "$PWD/backend/scripts:/t:ro" -v "$PWD/backend/test-fixtures:/fx:ro" \
//     backend node /t/test-e2e-http.js
// Cria um usuário de teste e apaga tudo (usuário, documentos, análises, arquivos) no fim.
const dns = require('dns').promises;
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const N_UPLOADS = parseInt(process.env.N_UPLOADS || '8', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(ip, method, path, { token, json, form } = {}) {
  const headers = {};
  if (token) headers.authorization = 'Bearer ' + token;
  let body;
  if (json) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(json);
  }
  if (form) body = form;
  const res = await fetch(`http://${ip}:3001${path}`, { method, headers, body });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  return { status: res.status, data };
}

(async () => {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'documents';
  const ips = (await dns.resolve4('backend')).sort();
  console.log('réplicas (IPs):', ips.join(', '));
  if (ips.length < 2) throw new Error('precisa de >=2 réplicas');
  const rep = (i) => ips[i % ips.length];
  const label = (ip) => 'réplica ...' + ip.split('.')[3];

  const email = `e2e-http+${Date.now()}@example.com`;
  const password = 'Senha-Teste-123!';
  let userId = null;
  const ok = [];
  const check = (nome, cond, extra = '') => {
    ok.push(cond);
    console.log(`${cond ? '✅' : '❌'} ${nome}${extra ? ' — ' + extra : ''}`);
  };

  try {
    const reg = await call(rep(0), 'POST', '/api/auth/register', { json: { email, password } });
    userId = reg.data && reg.data.user && reg.data.user.id;
    check(`cadastro na ${label(rep(0))}`, reg.status === 201, `status ${reg.status}`);

    const terms = await call(rep(1), 'POST', '/api/auth/accept-terms', {
      token: reg.data.accessToken,
      json: { version: process.env.TERMS_CURRENT_VERSION || '1.1.0' },
    });
    check(
      `aceite de termos na ${label(rep(1))} (token emitido por outra réplica)`,
      terms.status === 200,
      `status ${terms.status}`,
    );

    const login = await call(rep(2), 'POST', '/api/auth/login', { json: { email, password } });
    check(`login na ${label(rep(2))}`, login.status === 200, `status ${login.status}`);
    const token = login.data.accessToken;

    const pdf = fs.readFileSync('/fx/juridico-contrato-com-problemas.pdf');
    const uploads = await Promise.all(
      Array.from({ length: N_UPLOADS }, (_, i) => {
        const form = new FormData();
        form.append('file', new Blob([pdf], { type: 'application/pdf' }), `e2e-${i}.pdf`);
        form.append('area_negocio', 'juridico');
        return call(rep(i), 'POST', '/api/documents', { token, form });
      }),
    );
    const statuses = uploads.map((u) => u.status);
    check(
      `${N_UPLOADS} uploads simultâneos, distribuídos entre as réplicas`,
      statuses.every((s) => s === 201),
      `status: ${statuses.join(' ')}`,
    );
    const docIds = uploads.filter((u) => u.status === 201).map((u) => u.data.id);
    console.log('docIds:', docIds.map((d) => d.slice(0, 8)).join(' '));

    const deadline = Date.now() + 10 * 60 * 1000;
    let list = [];
    while (Date.now() < deadline) {
      const r = await call(rep(2), 'GET', '/api/documents', { token });
      if (r.status !== 200 || !Array.isArray(r.data)) {
        console.log(`\n  consulta falhou: status ${r.status} corpo ${JSON.stringify(r.data).slice(0, 160)}`);
        await sleep(5000);
        continue;
      }
      list = r.data.filter((d) => docIds.includes(d.id));
      const c = {};
      list.forEach((d) => (c[d.status] = (c[d.status] || 0) + 1));
      process.stdout.write('\r  status: ' + JSON.stringify(c) + '   ');
      if (list.length === docIds.length && list.every((d) => d.status === 'done' || d.status === 'error')) break;
      await sleep(5000);
    }
    console.log();

    const done = list.filter((d) => d.status === 'done').length;
    const err = list.filter((d) => d.status === 'error').length;
    check('todos os documentos chegaram a um estado final', done + err === docIds.length, `done=${done} error=${err}`);

    let comAnalise = 0;
    for (let i = 0; i < docIds.length; i++) {
      const r = await call(rep(i + 1), 'GET', '/api/documents/' + docIds[i], { token });
      if (r.status === 200 && r.data.status === 'done' && r.data.analise && r.data.analise.checklist) comAnalise++;
    }
    check(
      'resultado lido por réplica diferente da que recebeu o upload',
      comAnalise === done,
      `${comAnalise}/${done} com análise completa`,
    );

    console.log('RESULT ' + JSON.stringify({ docIds, userId, allOk: ok.every(Boolean) }));
  } finally {
    if (userId) {
      const { data: files } = await supabase.storage.from(bucket).list(userId, { limit: 100 });
      if (files && files.length) {
        await supabase.storage.from(bucket).remove(files.map((f) => `${userId}/${f.name}`));
      }
      await supabase.from('audit_logs').delete().eq('user_id', userId);
      await supabase.from('users').delete().eq('id', userId);
      console.log('limpeza feita (usuário, documentos, análises e arquivos de teste).');
    }
  }
})().catch((e) => {
  console.error('FALHA:', e && e.stack ? e.stack : e);
  process.exit(1);
});
