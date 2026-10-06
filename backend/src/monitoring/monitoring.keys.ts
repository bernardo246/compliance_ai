import type Redis from 'ioredis';

export const MONITORAMENTO_QUEUE = 'monitoramento';

// Batimentos: cada rotina periódica registra "rodei agora"; o alerta dispara se
// uma delas ficar tempo demais sem rodar.
export const HEARTBEAT_RETENCAO = 'monitor:hb:retencao';
export const HEARTBEAT_VARREDURA = 'monitor:hb:varredura';
export const MONITOR_INICIO = 'monitor:inicio';

/** Chave do contador de jobs que falharam de vez, por hora (UTC). */
export function chaveJobsFalhos(data: Date): string {
  return `monitor:jobs_falhos:${data.toISOString().slice(0, 13)}`;
}

/** Registra o batimento de uma rotina. Nunca lança: monitorar não pode derrubar o trabalho. */
export async function registrarBatimento(redis: Redis, chave: string): Promise<void> {
  try {
    await redis.set(chave, String(Date.now()), 'EX', 7 * 24 * 3600);
  } catch {
    // sem Redis o batimento some; o alerta de rotina parada pode disparar depois
  }
}

/** Conta mais um job que falhou de vez na hora atual. Nunca lança. */
export async function contarJobFalho(redis: Redis): Promise<void> {
  try {
    const chave = chaveJobsFalhos(new Date());
    await redis.incr(chave);
    await redis.expire(chave, 3 * 3600);
  } catch {
    // idem
  }
}
