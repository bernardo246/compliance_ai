// Monitor EXTERNO de disponibilidade: consulta /api/health/ready de fora da aplicação e
// avisa por webhook quando ela não está pronta (Redis ou banco fora, API fora do ar,
// Nginx/VM caídos, certificado vencido...). É o que cobre o buraco dos alertas internos:
// o job de alertas roda DENTRO do app e cai junto com ele.
//
// Sem dependências (Node 18+). Pensado para rodar a cada poucos minutos num agendador
// que NÃO seja a mesma máquina da aplicação (GitHub Actions em .github/workflows/uptime.yml,
// cron de outra máquina, Cloud Run Job, etc.). Serve também qualquer monitor pronto de
// mercado apontado para a mesma URL — ver README.
//
//   HEALTH_URL=https://api.exemplo.com/api/health/ready node backend/scripts/uptime-check.js
//
// Variáveis:
//   HEALTH_URL             (obrigatória) URL completa do /api/health/ready
//   ALERT_WEBHOOK_URL      onde avisar (o mesmo webhook dos alertas internos); vazio = só o exit code
//   ALERT_WEBHOOK_FORMAT   slack (padrão) | discord | generic — igual ao backend
//   UPTIME_RETRIES         tentativas antes de dar a queda como real (padrão 3)
//   UPTIME_RETRY_DELAY_MS  espera entre tentativas (padrão 10000)
//   UPTIME_TIMEOUT_MS      limite de cada tentativa (padrão 10000)
//   UPTIME_STATE_FILE      arquivo que guarda "estava fora"; com ele o aviso sai UMA vez por
//                          queda e sai o "resolvido" na volta (sem ele, avisa a cada execução
//                          que falhar e nunca envia "resolvido")
//
// Código de saída: 0 = pronto; 1 = fora (o agendador marca a execução como falha).
const fs = require('fs');

const env = process.env;
const URL_SAUDE = env.HEALTH_URL || '';
const WEBHOOK = env.ALERT_WEBHOOK_URL || '';
const FORMATO = env.ALERT_WEBHOOK_FORMAT || 'slack';
const TENTATIVAS = Math.max(1, parseInt(env.UPTIME_RETRIES || '3', 10) || 3);
const ESPERA_MS = Math.max(0, parseInt(env.UPTIME_RETRY_DELAY_MS || '10000', 10) || 0);
const TIMEOUT_MS = Math.max(1000, parseInt(env.UPTIME_TIMEOUT_MS || '10000', 10) || 10000);
const ESTADO = env.UPTIME_STATE_FILE || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Uma consulta. Devolve { ok, detalhe } e nunca lança. */
async function consultar() {
  try {
    const res = await fetch(URL_SAUDE, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'manual' });
    let corpo = null;
    try { corpo = await res.json(); } catch {}
    if (res.status === 200 && corpo && corpo.status === 'ok') return { ok: true, detalhe: 'Redis e banco ok' };
    const partes = corpo && corpo.redis ? ` (redis: ${corpo.redis}, banco: ${corpo.banco})` : '';
    return { ok: false, detalhe: `HTTP ${res.status}${partes}` };
  } catch (e) {
    const causa = e && e.cause && e.cause.code ? ` [${e.cause.code}]` : '';
    return { ok: false, detalhe: `sem resposta: ${e && e.name === 'TimeoutError' ? `timeout de ${TIMEOUT_MS} ms` : (e && e.message) || e}${causa}` };
  }
}

async function avisar(estado, detalhe) {
  const titulo = estado === 'resolvido' ? 'Aplicação voltou' : 'Aplicação fora do ar ou degradada';
  const prefixo = estado === 'resolvido' ? '[RESOLVIDO]' : '[CRÍTICO]';
  const texto = `${prefixo} ${titulo} — ${detalhe} (${URL_SAUDE})`;
  console.log(texto);
  if (!WEBHOOK) return;
  const corpo =
    FORMATO === 'discord'
      ? { content: texto }
      : FORMATO === 'generic'
        ? { evento: 'alerta', estado, regra: 'disponibilidade_externa', severidade: 'critico', titulo, detalhe, instancia: 'monitor-externo', timestamp: new Date().toISOString() }
        : { text: texto };
  try {
    const res = await fetch(WEBHOOK, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(corpo), signal: AbortSignal.timeout(8000) });
    if (!res.ok) console.error(`Webhook respondeu ${res.status}.`);
  } catch (e) {
    console.error(`Falha ao enviar o webhook: ${(e && e.message) || e}`);
  }
}

const lerEstado = () => { try { return ESTADO && fs.existsSync(ESTADO) && fs.readFileSync(ESTADO, 'utf8').trim() === 'fora'; } catch { return false; } };
const gravarEstado = (fora) => { try { if (ESTADO) fs.writeFileSync(ESTADO, fora ? 'fora' : 'ok'); } catch (e) { console.error(`Não consegui gravar o estado: ${e.message}`); } };

async function main() {
  if (!URL_SAUDE) {
    console.error('Defina HEALTH_URL (ex.: https://api.exemplo.com/api/health/ready).');
    process.exit(2);
  }
  let ultimo = null;
  for (let i = 1; i <= TENTATIVAS; i++) {
    ultimo = await consultar();
    console.log(`tentativa ${i}/${TENTATIVAS}: ${ultimo.ok ? 'OK' : 'FALHOU'} — ${ultimo.detalhe}`);
    if (ultimo.ok) break;
    if (i < TENTATIVAS) await sleep(ESPERA_MS);
  }

  const estavaFora = lerEstado();
  if (ultimo.ok) {
    if (estavaFora) await avisar('resolvido', 'a verificação voltou a passar');
    gravarEstado(false);
    return;
  }
  // Fora. Com arquivo de estado, avisa só na transição (uma vez por queda).
  if (!ESTADO || !estavaFora) await avisar('disparado', `${TENTATIVAS} tentativas seguidas falharam: ${ultimo.detalhe}`);
  gravarEstado(true);
  process.exitCode = 1;
}

main();
