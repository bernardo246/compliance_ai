// Teste do monitor externo (scripts/uptime-check.js) com um servidor de saúde FALSO e um
// receptor de webhook local: não precisa de Docker nem de Supabase.
// Opcional, com LIVE=1 e o compose de testes no ar (docker compose -f docker-compose.yml
// -f docker-compose.test.yml up -d --build): confere também contra o /api/health/ready real,
// parando e religando o Redis.
//   node backend/scripts/test-uptime-check.js
//   LIVE=1 node backend/scripts/test-uptime-check.js
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'uptime-check.js');
const ROOT = path.join(__dirname, '..', '..');
const resultados = [];
const check = (nome, ok, extra = '') => {
  resultados.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${nome}${extra ? ' — ' + extra : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let modo = 'ok'; // ok | degradado | travado
const saude = http.createServer((req, res) => {
  if (modo === 'travado') return; // nunca responde
  const ok = modo === 'ok';
  res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: ok ? 'ok' : 'degradado', redis: ok ? 'ok' : 'falhou', banco: 'ok' }));
});
const recebidos = [];
const hook = http.createServer((req, res) => {
  let c = '';
  req.on('data', (d) => (c += d));
  req.on('end', () => { try { recebidos.push(JSON.parse(c)); } catch {} res.writeHead(200).end('ok'); });
});

function rodar(extraEnv) {
  return new Promise((resolve) => {
    const p = spawn('node', [SCRIPT], { env: { PATH: process.env.PATH, UPTIME_RETRY_DELAY_MS: '100', ...extraEnv } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ code, out }));
  });
}

async function main() {
  await new Promise((r) => saude.listen(0, r));
  await new Promise((r) => hook.listen(0, r));
  const URL_SAUDE = `http://127.0.0.1:${saude.address().port}/api/health/ready`;
  const WEBHOOK = `http://127.0.0.1:${hook.address().port}/hook`;
  const estado = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'uptime-')), 'estado');
  const base = { HEALTH_URL: URL_SAUDE, ALERT_WEBHOOK_URL: WEBHOOK, ALERT_WEBHOOK_FORMAT: 'generic', UPTIME_STATE_FILE: estado, UPTIME_RETRIES: '3', UPTIME_TIMEOUT_MS: '1500' };

  let r = await rodar({ ...base });
  check('app pronto (200 + status ok): sai 0 e não avisa ninguém', r.code === 0 && recebidos.length === 0, `código ${r.code}`);

  r = await rodar({ HEALTH_URL: '' });
  check('sem HEALTH_URL: erro de configuração (código 2), não finge que está tudo bem', r.code === 2);

  modo = 'degradado';
  r = await rodar({ ...base });
  check('503 (Redis fora): 3 tentativas, sai 1 e avisa UMA vez', r.code === 1 && recebidos.length === 1 && (r.out.match(/tentativa \d\/3: FALHOU/g) || []).length === 3, `código ${r.code}, ${recebidos.length} aviso(s)`);
  const m = recebidos[0] || {};
  check('o aviso é crítico, com o motivo (HTTP 503 e Redis) e o formato generic', m.estado === 'disparado' && m.severidade === 'critico' && m.regra === 'disponibilidade_externa' && /HTTP 503/.test(m.detalhe) && /redis: falhou/.test(m.detalhe), m.detalhe);

  r = await rodar({ ...base });
  check('continua fora na execução seguinte: sai 1 mas NÃO repete o aviso (uma vez por queda)', r.code === 1 && recebidos.length === 1);

  modo = 'ok';
  r = await rodar({ ...base });
  check('voltou: sai 0 e envia "resolvido" uma única vez', r.code === 0 && recebidos.length === 2 && recebidos[1].estado === 'resolvido', `${recebidos.length} aviso(s)`);
  r = await rodar({ ...base });
  check('já resolvido: nenhuma mensagem nova', r.code === 0 && recebidos.length === 2);

  // oscilação: falha nas 2 primeiras tentativas, passa na 3ª → não é queda
  let n = 0;
  const flap = http.createServer((req, res) => {
    n++;
    const ok = n >= 3;
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: ok ? 'ok' : 'degradado', redis: 'ok', banco: 'ok' }));
  });
  await new Promise((rr) => flap.listen(0, rr));
  const antes = recebidos.length;
  r = await rodar({ ...base, HEALTH_URL: `http://127.0.0.1:${flap.address().port}/x`, UPTIME_STATE_FILE: path.join(path.dirname(estado), 'flap') });
  flap.close();
  check('falha momentânea (2 falhas e a 3ª passa): não é tratada como queda, sai 0 sem aviso', r.code === 0 && recebidos.length === antes, `${n} consultas`);

  modo = 'travado';
  const t0 = Date.now();
  r = await rodar({ ...base, UPTIME_RETRIES: '2', UPTIME_TIMEOUT_MS: '1000' });
  check('app travado (não responde): estoura o timeout, sai 1 e avisa "timeout" — não fica pendurado', r.code === 1 && /timeout/.test(r.out) && Date.now() - t0 < 6000 && recebidos.length === 3, `${Date.now() - t0} ms`);

  modo = 'ok';
  await rodar({ ...base }); // limpa o estado (envia "resolvido")
  const portaMorta = http.createServer().listen(0);
  const porta = await new Promise((rr) => portaMorta.on('listening', () => rr(portaMorta.address().port)));
  portaMorta.close();
  await sleep(100);
  const antes2 = recebidos.length;
  r = await rodar({ ...base, HEALTH_URL: `http://127.0.0.1:${porta}/x`, UPTIME_STATE_FILE: '' });
  check('nada escutando na porta (VM/Nginx fora do ar): sai 1 e avisa com ECONNREFUSED', r.code === 1 && /ECONNREFUSED/.test(r.out) && recebidos.length === antes2 + 1);

  r = await rodar({ ...base, HEALTH_URL: `http://127.0.0.1:${porta}/x`, UPTIME_STATE_FILE: '', ALERT_WEBHOOK_URL: '' });
  check('sem webhook configurado: ainda sai 1 (o agendador marca a execução como falha)', r.code === 1);

  r = await rodar({ ...base, HEALTH_URL: `http://127.0.0.1:${porta}/x`, UPTIME_STATE_FILE: '', ALERT_WEBHOOK_URL: `http://127.0.0.1:${porta}/hook` });
  check('webhook inalcançável: não quebra, registra o erro e mantém o código 1', r.code === 1 && /Falha ao enviar o webhook/.test(r.out));

  const antes3 = recebidos.length;
  modo = 'degradado';
  await rodar({ ...base, ALERT_WEBHOOK_FORMAT: 'slack', UPTIME_STATE_FILE: '' });
  await rodar({ ...base, ALERT_WEBHOOK_FORMAT: 'discord', UPTIME_STATE_FILE: '' });
  check('formatos slack (text) e discord (content) seguem o mesmo padrão dos alertas internos', !!recebidos[antes3] && /CRÍTICO/.test(recebidos[antes3].text) && !!recebidos[antes3 + 1] && /CRÍTICO/.test(recebidos[antes3 + 1].content));

  // ---- opcional: contra o app real ------------------------------------------------------
  if (process.env.LIVE === '1') {
    const real = (process.env.LB_URL || 'http://localhost:8080') + '/api/health/ready';
    const liveEstado = path.join(path.dirname(estado), 'live');
    const antesLive = recebidos.length;
    const lenv = { ...base, HEALTH_URL: real, UPTIME_STATE_FILE: liveEstado, UPTIME_RETRIES: '2', UPTIME_RETRY_DELAY_MS: '6000' };
    r = await rodar(lenv);
    check('AO VIVO: com tudo no ar, o monitor passa (exit 0, sem aviso)', r.code === 0 && recebidos.length === antesLive, r.out.trim().split('\n').pop());
    execSync('docker compose stop redis', { cwd: ROOT, stdio: 'ignore' });
    try {
      await sleep(7000); // cache de 5 s do endpoint
      r = await rodar(lenv);
      check('AO VIVO: com o Redis parado, o monitor detecta (exit 1) e avisa uma vez', r.code === 1 && recebidos.length === antesLive + 1 && /redis: falhou/.test(recebidos[antesLive].detalhe), recebidos[antesLive] && recebidos[antesLive].detalhe);
    } finally {
      execSync('docker compose start redis', { cwd: ROOT, stdio: 'ignore' });
    }
    let voltou = false;
    for (let i = 0; i < 30 && !voltou; i++) {
      await sleep(2000);
      voltou = (await fetch(real).then((x) => x.status, () => 0)) === 200;
    }
    await sleep(6000);
    r = await rodar(lenv);
    check('AO VIVO: com o Redis de volta, o monitor passa e envia o "resolvido"', voltou && r.code === 0 && recebidos[recebidos.length - 1].estado === 'resolvido');
  }

  saude.close();
  hook.close();
  const ok = resultados.every(Boolean);
  console.log(ok ? `\n✅ ${resultados.length} de ${resultados.length} verificações passaram.` : `\n❌ ${resultados.filter((x) => !x).length} verificação(ões) falharam.`);
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error('FALHA:', e); process.exit(1); });
