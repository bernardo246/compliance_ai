/**
 * Teste OFFLINE da validação de configuração de produção
 * (src/config/production-checks.ts): cada regra, o que é erro (impede o boot)
 * e o que é só aviso, e que fora de produção ela não interfere.
 */
import { checkProductionConfig } from '../src/config/production-checks';

const OK_ENV: Record<string, string> = {
  NODE_ENV: 'production',
  SUPABASE_URL: 'https://x.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'k',
  JWT_PRIVATE_KEY: 'p',
  JWT_PUBLIC_KEY: 'q',
  OPENROUTER_API_KEY: 'o',
  OPENROUTER_MODEL: 'provedor/modelo-pago',
  REDIS_URL: 'rediss://default:senha@redis.exemplo.com:6380',
  FRONTEND_URL: 'https://app.exemplo.com',
  TRUST_PROXY: 'true',
  ALERT_WEBHOOK_URL: 'https://hooks.exemplo.com/abc',
};

const resultados: boolean[] = [];
const check = (nome: string, ok: boolean, extra = '') => {
  resultados.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${nome}${extra ? ' — ' + extra : ''}`);
};
const com = (mudancas: Record<string, string | undefined>) => ({ ...OK_ENV, ...mudancas });
const tem = (lista: string[], trecho: string) => lista.some((m) => m.includes(trecho));

// 1. fora de produção não verifica nada
{
  const r = checkProductionConfig({ NODE_ENV: 'development', REDIS_URL: '' });
  check('fora de produção: nenhum erro nem aviso', r.errors.length === 0 && r.warnings.length === 0);
}

// 2. configuração correta
{
  const r = checkProductionConfig(OK_ENV);
  check('produção correta: sem erros e sem avisos', r.errors.length === 0 && r.warnings.length === 0, JSON.stringify(r));
}

// 3. segredos obrigatórios
for (const nome of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY', 'OPENROUTER_API_KEY']) {
  const r = checkProductionConfig(com({ [nome]: '' }));
  check(`${nome} vazia é erro`, tem(r.errors, nome));
}

// 4. Redis
{
  const sem = checkProductionConfig(com({ REDIS_URL: undefined }));
  check('REDIS_URL ausente é erro', tem(sem.errors, 'REDIS_URL não está definida'));
  for (const url of ['redis://localhost:6379', 'rediss://:s@127.0.0.1:6380', 'redis://[::1]:6379']) {
    const r = checkProductionConfig(com({ REDIS_URL: url }));
    check(`REDIS_URL local é erro (${url})`, tem(r.errors, 'não há Redis na própria máquina'));
  }
  const inval = checkProductionConfig(com({ REDIS_URL: 'isso nao e url' }));
  check('REDIS_URL inválida é erro', tem(inval.errors, 'não é uma URL válida'));
  const semTls = checkProductionConfig(com({ REDIS_URL: 'redis://default:senha@redis.exemplo.com:6379' }));
  check('redis:// sem TLS é só aviso (não erro)', semTls.errors.length === 0 && tem(semTls.warnings, 'não usa TLS'));
  const semSenha = checkProductionConfig(com({ REDIS_URL: 'rediss://redis.exemplo.com:6380' }));
  check('REDIS_URL sem senha é só aviso', semSenha.errors.length === 0 && tem(semSenha.warnings, 'não tem senha'));
}

// 5. avisos de cookie/proxy/debug
{
  const http = checkProductionConfig(com({ FRONTEND_URL: 'http://app.exemplo.com' }));
  check('FRONTEND_URL http é aviso (cookie secure)', http.errors.length === 0 && tem(http.warnings, 'FRONTEND_URL'));
  const proxy = checkProductionConfig(com({ TRUST_PROXY: 'false' }));
  check('TRUST_PROXY desligado é aviso', proxy.errors.length === 0 && tem(proxy.warnings, 'TRUST_PROXY'));
  const semAlerta = checkProductionConfig(com({ ALERT_WEBHOOK_URL: '' }));
  check('sem ALERT_WEBHOOK_URL é só aviso (os alertas ficariam só no log)', semAlerta.errors.length === 0 && tem(semAlerta.warnings, 'ALERT_WEBHOOK_URL'));
  const dbg = checkProductionConfig(com({ ENABLE_DEBUG_ENDPOINT: 'true' }));
  check('endpoint de debug ligado é aviso', dbg.errors.length === 0 && tem(dbg.warnings, 'ENABLE_DEBUG_ENDPOINT'));
}

// 6. privacidade do provedor de IA (modelo gratuito em produção é permitido, com avisos)
{
  const allow = checkProductionConfig(com({ OPENROUTER_DATA_COLLECTION: 'allow' }));
  check('OPENROUTER_DATA_COLLECTION=allow em produção NÃO impede o boot (é uma escolha), mas avisa do treino', allow.errors.length === 0 && tem(allow.warnings, 'treino'), JSON.stringify(allow.errors));
  const deny = checkProductionConfig(com({ OPENROUTER_DATA_COLLECTION: 'deny' }));
  check('deny (ou ausente) com modelo pago: sem erros e sem avisos', deny.errors.length === 0 && deny.warnings.length === 0);
  const freeAllow = checkProductionConfig(com({ OPENROUTER_MODEL: 'nvidia/nemotron-3-super-120b-a12b:free', OPENROUTER_DATA_COLLECTION: 'allow' }));
  check('modelo ":free" + allow: sobe, com aviso do treino e do limite diário', freeAllow.errors.length === 0 && tem(freeAllow.warnings, 'treino') && tem(freeAllow.warnings, 'limite diário'));
  const freeDeny = checkProductionConfig(com({ OPENROUTER_MODEL: 'nvidia/nemotron-3-super-120b-a12b:free' }));
  check('modelo ":free" + deny: sobe, mas avisa que as análises vão falhar com 404', freeDeny.errors.length === 0 && tem(freeDeny.warnings, '404'));
  const semModelo = checkProductionConfig(com({ OPENROUTER_MODEL: undefined }));
  check('modelo não definido (cai no padrão grátis) também avisa', semModelo.errors.length === 0 && tem(semModelo.warnings, 'OPENROUTER_MODEL'));
}

const ok = resultados.every(Boolean);
console.log(ok ? `\n✅ ${resultados.length} de ${resultados.length} verificações passaram.` : `\n❌ ${resultados.filter((r) => !r).length} verificação(ões) falharam.`);
process.exitCode = ok ? 0 : 1;
