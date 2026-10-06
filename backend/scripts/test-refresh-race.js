// Teste de corrida da rotação do refresh token, pela API HTTP real.
//
// Cria um usuário, pega o cookie de refresh do cadastro e dispara N chamadas
// SIMULTÂNEAS a /api/auth/refresh com o MESMO cookie. O token é de uso único:
// exatamente 1 chamada pode dar certo.
//   Antes da correção (leitura e revogação em dois passos): várias dão certo e
//   sobram vários refresh tokens válidos (dupla utilização).
//   Depois (revogação atômica): 1 dá 200, as outras 401, e no máximo 1 token
//   válido sobra no banco.
//
//   LB_URL=http://localhost:8080 node backend/scripts/test-refresh-race.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const { createClient } = require('@supabase/supabase-js');

const BASE = process.env.LB_URL || 'http://localhost:8080';
const N = parseInt(process.env.N_PARALLEL || '8', 10);

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const email = `refresh-race+${Date.now()}@example.com`;
  let userId = null;
  const resultados = [];
  const check = (nome, ok, extra = '') => {
    resultados.push(ok);
    console.log(`${ok ? '✅' : '❌'} ${nome}${extra ? ' — ' + extra : ''}`);
  };

  try {
    const reg = await fetch(BASE + '/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'Senha-Teste-123!' }),
    });
    const body = await reg.json();
    userId = body.user && body.user.id;
    const cookie = (reg.headers.getSetCookie() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('refresh_token='));
    if (!cookie) throw new Error('cadastro não devolveu o cookie de refresh (status ' + reg.status + ')');

    const respostas = await Promise.all(
      Array.from({ length: N }, () =>
        fetch(BASE + '/api/auth/refresh', { method: 'POST', headers: { cookie } }).then((r) => r.status),
      ),
    );
    const sucessos = respostas.filter((s) => s === 200).length;
    console.log(`${N} chamadas simultâneas com o MESMO refresh token: ${respostas.join(' ')}`);

    const { data: tokens } = await supabase.from('refresh_tokens').select('id,revoked').eq('user_id', userId);
    const validos = (tokens || []).filter((t) => !t.revoked).length;
    console.log(`refresh tokens no banco: ${(tokens || []).length} (válidos: ${validos})`);

    check('o token de uso único funcionou exatamente 1 vez', sucessos === 1, `${sucessos} resposta(s) 200`);
    check('no máximo 1 refresh token válido sobrou (sem dupla utilização)', validos <= 1, `${validos} válido(s)`);
  } finally {
    if (userId) {
      await supabase.from('audit_logs').delete().eq('user_id', userId);
      await supabase.from('users').delete().eq('id', userId);
      console.log('limpeza feita (usuário de teste e tokens).');
    }
  }
  const ok = resultados.every(Boolean);
  console.log(ok ? '\n✅ Sem corrida no refresh.' : '\n❌ CORRIDA DETECTADA no refresh.');
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.error('FALHA:', e && e.stack ? e.stack : e);
  process.exit(1);
});
