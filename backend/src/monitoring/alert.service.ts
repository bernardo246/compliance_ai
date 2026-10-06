import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../common/redis/redis.constants';
import { SupabaseService } from '../common/supabase/supabase.service';
import { ANALISES_QUEUE } from '../analysis/analysis-queue.service';
import {
  HEARTBEAT_RETENCAO,
  HEARTBEAT_VARREDURA,
  MONITORAMENTO_QUEUE,
  MONITOR_INICIO,
  chaveJobsFalhos,
} from './monitoring.keys';

export type Severidade = 'critico' | 'aviso';

export interface RegraResultado {
  id: string;
  /** true = a condição de alerta está ativa agora */
  disparada: boolean;
  /** true = não deu para avaliar (ex.: banco fora): não muda o estado do alerta */
  desconhecida?: boolean;
  severidade: Severidade;
  titulo: string;
  detalhe: string;
}

// Limites fixos (não são variáveis de ambiente de propósito: poucos botões).
export const LIMITES = {
  documentoParadoMin: 15, // pendente há mais que isto = parado (a varredura deveria ter resgatado)
  filaMaxEspera: 50, // jobs de análise esperando
  taxaErroMaxima: 0.5, // fração de análises com erro na janela
  amostraMinimaErro: 5, // só avalia a taxa com pelo menos tantas análises finalizadas
  janelaErroMin: 15,
  retencaoMaxIdadeMs: 2.5 * 3600_000, // roda de hora em hora
  varreduraMinIdadeMs: 15 * 60_000, // piso; o limite real é 4× o intervalo da varredura
} as const;

const REGRAS_DO_BANCO = ['documentos_parados', 'taxa_de_erro_alta'];

/**
 * Alertas de monitoramento. Um job repetível (BullMQ, uma execução por intervalo
 * em UMA réplica) chama `executar()`, que avalia as regras, controla repetição
 * (um alerta já disparado só é repetido depois do cooldown) e avisa por webhook
 * quando a condição aparece e quando ela some ("resolvido").
 *
 * Limite conhecido: se o app inteiro estiver fora, este job também está — para
 * isso existe o endpoint /api/health/ready, para um monitor EXTERNO de
 * disponibilidade (ver README).
 */
@Injectable()
export class AlertService implements OnModuleInit {
  private readonly logger = new Logger(AlertService.name);

  constructor(
    @InjectQueue(MONITORAMENTO_QUEUE) private readonly monitorQueue: Queue,
    @InjectQueue(ANALISES_QUEUE) private readonly analysisQueue: Queue,
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async onModuleInit() {
    const every = this.config.get<number>('monitoring.intervalMs') ?? 60_000;
    // Todas as réplicas registram o mesmo scheduler (idempotente): o Redis dispara
    // UMA execução por intervalo.
    await this.monitorQueue.upsertJobScheduler(
      'avaliar-alertas',
      { every },
      { name: 'avaliar', opts: { removeOnComplete: true, removeOnFail: true } },
    );
  }

  // ----------------------------------------------------------------- avaliação

  async avaliar(): Promise<RegraResultado[]> {
    const resultados: RegraResultado[] = [];
    const agora = Date.now();

    const bancoRegras = await Promise.allSettled([
      this.regraDocumentosParados(agora),
      this.regraTaxaDeErro(agora),
    ]);
    const bancoCaiu = bancoRegras.some((r) => r.status === 'rejected');
    bancoRegras.forEach((r, i) => {
      if (r.status === 'fulfilled') resultados.push(r.value);
      else
        resultados.push({
          id: REGRAS_DO_BANCO[i],
          disparada: false,
          desconhecida: true,
          severidade: 'aviso',
          titulo: REGRAS_DO_BANCO[i],
          detalhe: String(r.reason),
        });
    });
    resultados.push({
      id: 'banco_inacessivel',
      disparada: bancoCaiu,
      severidade: 'critico',
      titulo: 'Banco de dados inacessível',
      detalhe: bancoCaiu
        ? 'As consultas ao banco falharam; análises e logins podem estar parados.'
        : 'Consultas ao banco funcionando.',
    });

    resultados.push(await this.regraFilaAcumulada());
    resultados.push(await this.regraJobsFalhos(agora));
    resultados.push(...(await this.regrasRotinasParadas(agora)));
    return resultados;
  }

  private async regraDocumentosParados(agora: number): Promise<RegraResultado> {
    const limite = new Date(agora - LIMITES.documentoParadoMin * 60_000).toISOString();
    const { count, error } = await this.supabase
      .getClient()
      .from('documents')
      .select('id', { count: 'exact', head: true })
      .is('deletado_em', null)
      .in('status', ['uploaded', 'processing'])
      .lt('created_at', limite);
    if (error) throw new Error(error.message);
    const n = count ?? 0;
    return {
      id: 'documentos_parados',
      disparada: n > 0,
      severidade: 'critico',
      titulo: 'Documentos parados',
      detalhe:
        n > 0
          ? `${n} documento(s) pendente(s) há mais de ${LIMITES.documentoParadoMin} min — a varredura periódica deveria tê-los reenfileirado.`
          : 'Nenhum documento parado.',
    };
  }

  private async regraTaxaDeErro(agora: number): Promise<RegraResultado> {
    const desde = new Date(agora - LIMITES.janelaErroMin * 60_000).toISOString();
    const contar = async (status: string[]) => {
      const { count, error } = await this.supabase
        .getClient()
        .from('documents')
        .select('id', { count: 'exact', head: true })
        .in('status', status)
        .gte('created_at', desde);
      if (error) throw new Error(error.message);
      return count ?? 0;
    };
    const finalizados = await contar(['done', 'error']);
    const comErro = await contar(['error']);
    const taxa = finalizados > 0 ? comErro / finalizados : 0;
    const disparada = finalizados >= LIMITES.amostraMinimaErro && taxa >= LIMITES.taxaErroMaxima;
    return {
      id: 'taxa_de_erro_alta',
      disparada,
      severidade: 'critico',
      titulo: 'Taxa de erro das análises alta',
      detalhe: disparada
        ? `${comErro} de ${finalizados} análises terminaram em erro nos últimos ${LIMITES.janelaErroMin} min (provável falha ou limite do modelo de IA).`
        : `${comErro} de ${finalizados} análises com erro nos últimos ${LIMITES.janelaErroMin} min.`,
    };
  }

  private async regraFilaAcumulada(): Promise<RegraResultado> {
    try {
      const { waiting } = await this.analysisQueue.getJobCounts('waiting');
      const disparada = (waiting ?? 0) > LIMITES.filaMaxEspera;
      return {
        id: 'fila_acumulada',
        disparada,
        severidade: 'aviso',
        titulo: 'Fila de análises acumulada',
        detalhe: disparada
          ? `${waiting} análises esperando (limite ${LIMITES.filaMaxEspera}): os workers não estão dando conta ou estão parados.`
          : `${waiting ?? 0} análise(s) esperando.`,
      };
    } catch (e) {
      return this.desconhecida('fila_acumulada', e);
    }
  }

  private async regraJobsFalhos(agora: number): Promise<RegraResultado> {
    try {
      const atual = Number((await this.redis.get(chaveJobsFalhos(new Date(agora)))) ?? 0);
      const anterior = Number((await this.redis.get(chaveJobsFalhos(new Date(agora - 3600_000)))) ?? 0);
      const total = atual + anterior;
      return {
        id: 'jobs_falhos',
        disparada: total > 0,
        severidade: 'aviso',
        titulo: 'Jobs de análise falharam de vez',
        detalhe:
          total > 0
            ? `${total} job(s) falharam definitivamente nas últimas 2 horas (ex.: workers que caíram no meio da análise).`
            : 'Nenhum job falhou de vez recentemente.',
      };
    } catch (e) {
      return this.desconhecida('jobs_falhos', e);
    }
  }

  private async regrasRotinasParadas(agora: number): Promise<RegraResultado[]> {
    try {
      // Marca quando o monitoramento começou: sem batimento ainda, só alerta depois do limite.
      await this.redis.set(MONITOR_INICIO, String(agora), 'NX');
      const inicio = Number((await this.redis.get(MONITOR_INICIO)) ?? agora);
      const intervaloVarredura = this.config.get<number>('analysis.recoveryIntervalMs') ?? 300_000;
      const rotinas = [
        { id: 'rotina_retencao_parada', nome: 'Retenção de 72h', chave: HEARTBEAT_RETENCAO, limiteMs: LIMITES.retencaoMaxIdadeMs },
        {
          id: 'rotina_varredura_parada',
          nome: 'Varredura de documentos parados',
          chave: HEARTBEAT_VARREDURA,
          limiteMs: Math.max(LIMITES.varreduraMinIdadeMs, intervaloVarredura * 4),
        },
      ];
      const out: RegraResultado[] = [];
      for (const r of rotinas) {
        const ultimo = Number((await this.redis.get(r.chave)) ?? 0);
        const referencia = ultimo > 0 ? ultimo : inicio;
        const idade = agora - referencia;
        const disparada = idade > r.limiteMs;
        out.push({
          id: r.id,
          disparada,
          severidade: 'critico',
          titulo: `Rotina parada: ${r.nome}`,
          detalhe: disparada
            ? `${r.nome} não roda há ${Math.round(idade / 60_000)} min (limite ${Math.round(r.limiteMs / 60_000)} min).`
            : `${r.nome} rodando normalmente.`,
        });
      }
      return out;
    } catch (e) {
      return [this.desconhecida('rotina_retencao_parada', e), this.desconhecida('rotina_varredura_parada', e)];
    }
  }

  private desconhecida(id: string, erro: unknown): RegraResultado {
    return { id, disparada: false, desconhecida: true, severidade: 'aviso', titulo: id, detalhe: String(erro) };
  }

  // ----------------------------------------------------------- repetição e envio

  /** Avalia e envia o que mudou. É o que o job periódico chama. */
  async executar(): Promise<RegraResultado[]> {
    const cooldownMs = this.config.get<number>('monitoring.cooldownMs') ?? 1_800_000;
    const resultados = await this.avaliar();

    for (const r of resultados) {
      if (r.desconhecida) continue; // não dá para saber: não mexe no estado
      const chave = `alert:firing:${r.id}`;
      try {
        if (r.disparada) {
          // NX: só o primeiro disparo (ou o primeiro depois do cooldown) avisa
          const novo = await this.redis.set(chave, String(Date.now()), 'PX', cooldownMs, 'NX');
          if (novo === 'OK') await this.notificar('disparado', r);
        } else if ((await this.redis.del(chave)) > 0) {
          await this.notificar('resolvido', r);
        }
      } catch (e) {
        this.logger.error(`Falha ao processar o alerta ${r.id}: ${e instanceof Error ? e.message : e}`);
      }
    }
    return resultados;
  }

  private async notificar(estado: 'disparado' | 'resolvido', r: RegraResultado): Promise<void> {
    const prefixo = estado === 'resolvido' ? '[RESOLVIDO]' : r.severidade === 'critico' ? '[CRÍTICO]' : '[AVISO]';
    const texto = `${prefixo} ${r.titulo} — ${r.detalhe}`;
    if (estado === 'disparado') this.logger.error(`ALERTA ${texto}`);
    else this.logger.log(`ALERTA ${texto}`);

    const url = this.config.get<string>('monitoring.webhookUrl');
    if (!url) return;
    const formato = this.config.get<string>('monitoring.webhookFormat') ?? 'slack';
    const corpo =
      formato === 'discord'
        ? { content: texto }
        : formato === 'generic'
          ? {
              evento: 'alerta',
              estado,
              regra: r.id,
              severidade: r.severidade,
              titulo: r.titulo,
              detalhe: r.detalhe,
              instancia: process.env.HOSTNAME ?? `pid-${process.pid}`,
              timestamp: new Date().toISOString(),
            }
          : { text: texto };
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) this.logger.error(`Webhook de alertas respondeu ${res.status}.`);
    } catch (e) {
      this.logger.error(`Falha ao enviar o alerta por webhook: ${e instanceof Error ? e.message : e}`);
    }
  }
}
