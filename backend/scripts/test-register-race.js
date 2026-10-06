// Teste de corrida do cadastro: N cadastros SIMULTÂNEOS com o MESMO e-mail, pela API
// real (3 réplicas atrás do Nginx). O e-mail é único no banco, então exatamente 1
// pode dar certo (201) e as demais devem receber 409 (conflito) — nunca 500.
//   Antes da correção: 1× 201 e o resto 500 (a leitura "já existe?" passa em todas e
//   o banco recusa a inserção com um erro interno).
//
//   LB_URL=http://localhost:8080 node backend/scripts/test-register-race.js
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), quiet: true });
const { createClient } = require('@supabase/supabase-js');

const BASE = process.env.LB_URL || 'http://localhost:8080';
// O cadastro tem limite de 5 por minuto por IP: 5 chamadas cabem na janela.
const N = parseInt(process.env.N_PARALLEL || '5', 10);

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const email = `register-race+${Date.now()}@example.com`;
  const resultados = [];
  const check = (nome, ok, extra = '') => {
    resultados.push(ok);
    console.log(`${ok ? '✅' : '❌'} ${nome}${extra ? ' — ' + extra : ''}`);
  };

  try {
    const respostas = await Promise.all(
      Array.from({ length: N }, () =>
        fetch(BASE + '/api/auth/register', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password: 'Senha-Teste-123!' }),
        }).then(async (r) => ({ status: r.status, corpo: await r.json().catch(() => ({})) })),
      ),
    );
    const status = respostas.map((r) => r.status);
    console.log(`${N} cadastros simultâneos com o MESMO e-mail: ${status.join(' ')}`);
    const { data: usuarios } = await supabase.from('users').select('id').eq('email', email);

    check('exatamente 1 cadastro foi criado', status.filter((s) => s === 201).length === 1 && usuarios.length === 1, `${status.filter((s) => s === 201).length}× 201, ${usuarios.length} usuário(s) no banco`);
    check('os demais recebem 409 (conflito), nunca 500', status.filter((s) => s !== 201).every((s) => s === 409), `status das demais: ${status.filter((s) => s !== 201).join(' ')}`);
    const vazou = respostas.some((r) => /duplicate key|violates|constraint/i.test(JSON.stringify(r.corpo)));
    check('nenhuma resposta vaza mensagem interna do banco', !vazou);
  } finally {
    const { data: usuarios } = await supabase.from('users').select('id').eq('email', email);
    for (const u of usuarios || []) {
      await supabase.from('audit_logs').delete().eq('user_id', u.id);
      await supabase.from('users').delete().eq('id', u.id);
    }
    console.log('limpeza feita.');
  }
  const ok = resultados.every(Boolean);
  console.log(ok ? '\n✅ Sem corrida no cadastro.' : '\n❌ CORRIDA DETECTADA no cadastro.');
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => {
  console.error('FALHA:', e && e.stack ? e.stack : e);
  process.exit(1);
});
