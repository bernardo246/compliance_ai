export interface ProductionCheckResult {
  errors: string[];
  warnings: string[];
}

const REQUIRED_IN_PRODUCTION = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'JWT_PRIVATE_KEY',
  'JWT_PUBLIC_KEY',
  'OPENROUTER_API_KEY',
] as const;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

const blank = (v: string | undefined) => v === undefined || v.trim() === '';

/**
 * Valida a configuração quando NODE_ENV=production, ANTES de o Nest subir
 * qualquer conexão. `errors` impedem o boot (algo que certamente quebra em
 * produção); `warnings` só avisam (configurações que funcionam, mas são
 * arriscadas). Fora de produção não verifica nada.
 */
export function checkProductionConfig(
  env: Record<string, string | undefined>,
): ProductionCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (env.NODE_ENV !== 'production') return { errors, warnings };

  for (const name of REQUIRED_IN_PRODUCTION) {
    if (blank(env[name])) errors.push(`${name} não está definida.`);
  }

  const redisUrl = env.REDIS_URL;
  if (blank(redisUrl)) {
    errors.push('REDIS_URL não está definida (o rate limit e a fila de análise dependem do Redis).');
  } else {
    let parsed: URL | null = null;
    try {
      parsed = new URL(redisUrl!);
    } catch {
      errors.push('REDIS_URL não é uma URL válida (esperado redis://... ou rediss://...).');
    }
    if (parsed) {
      if (LOCAL_HOSTS.has(parsed.hostname)) {
        errors.push(
          `REDIS_URL aponta para ${parsed.hostname}: em produção não há Redis na própria máquina/container. Use o endereço do Redis gerenciado.`,
        );
      }
      if (parsed.protocol !== 'rediss:') {
        warnings.push(
          'REDIS_URL não usa TLS (rediss://): a senha e os dados da fila trafegam sem criptografia. Aceitável só em rede privada.',
        );
      }
      if (blank(parsed.password)) {
        warnings.push('REDIS_URL não tem senha: qualquer um que alcance o Redis na rede pode ler e alterar a fila.');
      }
    }
  }

  if (!blank(env.FRONTEND_URL) && !env.FRONTEND_URL!.startsWith('https://')) {
    warnings.push(
      'FRONTEND_URL não é https://: em produção o cookie do refresh token é "secure" e o navegador não o envia por HTTP, então o login não se mantém.',
    );
  }

  if (env.TRUST_PROXY !== 'true') {
    warnings.push(
      'TRUST_PROXY não é "true": atrás de um load balancer, o rate limit e os logs de auditoria enxergarão o IP do proxy em vez do cliente. Ligue só se houver um proxy confiável na frente.',
    );
  }

  if (env.ENABLE_DEBUG_ENDPOINT === 'true') {
    warnings.push(
      'ENABLE_DEBUG_ENDPOINT=true: /api/debug/instance está ligado, público e fora do rate limit. Desligue em produção.',
    );
  }

  return { errors, warnings };
}
