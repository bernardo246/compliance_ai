import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { SupabaseService } from '../common/supabase/supabase.service';

export const RETENCAO_QUEUE = 'retencao';

export interface RetentionSweepResult {
  processados: number;
  falhas: number;
}

/**
 * Fase 7 — Retenção de 72h (LGPD, minimização de dados — spec seção 9).
 *
 * Roda a cada hora e remove o **arquivo original** de documentos cujo
 * `expira_em` já passou. Só o binário no Storage é apagado — a linha em
 * `documents` continua existindo (com `storage_path = null` e
 * `deletado_em` preenchido) e o resultado em `analyses` **não é tocado**,
 * porque não guarda o documento original, só o output estruturado da IA.
 *
 * A exclusão antecipada (usuário apaga antes das 72h) já existe desde a
 * Fase 3 em `DocumentsService.deleteForUser()` — mesmo efeito final
 * (storage_path null + deletado_em), só que disparado por request em vez
 * de pelo cron.
 */
@Injectable()
export class RetentionService implements OnModuleInit {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
    @InjectQueue(RETENCAO_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Fase 5 — agenda a varredura no Redis (BullMQ) em vez de @Cron em memória.
   * `upsertJobScheduler` é idempotente: todas as réplicas registram o mesmo
   * scheduler e o Redis mantém um só, então a cada hora UM job é criado e
   * processado por UM worker — sem varredura duplicada por réplica.
   */
  async onModuleInit() {
    await this.queue.upsertJobScheduler(
      'retencao-horaria',
      { pattern: '0 * * * *' },
      { name: 'purgar', opts: { removeOnComplete: true, removeOnFail: true } },
    );
  }

  private db() {
    return this.supabase.getClient();
  }

  async purgeExpired(): Promise<RetentionSweepResult> {
    const bucket = this.config.get<string>('supabase.storageBucket')!;
    const nowIso = new Date().toISOString();

    // Candidatos: ainda não excluídos, com arquivo de fato presente no
    // Storage, e com prazo vencido.
    const { data, error } = await this.db()
      .from('documents')
      .select('id, storage_path')
      .is('deletado_em', null)
      .not('storage_path', 'is', null)
      .lt('expira_em', nowIso);

    if (error) {
      this.logger.error(`Falha ao varrer documentos expirados: ${error.message}`);
      return { processados: 0, falhas: 0 };
    }

    if (!data || data.length === 0) {
      return { processados: 0, falhas: 0 };
    }

    this.logger.log(`Retenção de 72h: ${data.length} documento(s) expirado(s) a limpar.`);

    let processados = 0;
    let falhas = 0;

    // Sequencial de propósito: são operações de Storage + banco, volume
    // baixo (só o que expira por hora), e evita martelar o Storage com N
    // remoções em paralelo.
    for (const doc of data) {
      try {
        const { error: removeError } = await this.db()
          .storage.from(bucket)
          .remove([doc.storage_path as string]);
        if (removeError) {
          throw new Error(`Storage: ${removeError.message}`);
        }

        const { error: updateError } = await this.db()
          .from('documents')
          .update({ storage_path: null, deletado_em: new Date().toISOString() })
          .eq('id', doc.id);
        if (updateError) {
          throw new Error(`Banco: ${updateError.message}`);
        }

        processados += 1;
      } catch (err) {
        falhas += 1;
        this.logger.error(
          `Falha ao expirar o documento ${doc.id}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    this.logger.log(`Retenção de 72h concluída: ${processados} limpo(s), ${falhas} falha(s).`);
    return { processados, falhas };
  }
  /**
   * Apaga refresh tokens que não servem mais. Cada renovação de sessão grava uma
   * linha em `refresh_tokens` (rotação) e nada as removia: a tabela só crescia.
   * Duas passadas:
   *  - EXPIRADOS: não servem a nada (nem para detectar reuso);
   *  - REVOGADOS há mais de `jwt.revokedRefreshRetentionMs` (padrão 1 hora, pela data
   *    de emissão): um token revogado só precisa existir para o reuso dele ser
   *    detectado como roubo (e derrubar a sessão inteira); passada a janela, ele já
   *    era recusado de qualquer forma (aqui passa a ser "inválido" em vez de "reuso").
   * Em lotes pequenos (a URL do DELETE leva os ids): até 50 lotes de 100 por
   * passada; um acúmulo grande é drenado nas próximas execuções horárias.
   */
  async purgeStaleRefreshTokens(): Promise<number> {
    const agora = new Date();
    const janelaMs = this.config.get<number>('jwt.revokedRefreshRetentionMs') ?? 3_600_000;
    const limiteRevogados = new Date(agora.getTime() - janelaMs).toISOString();
    const expirados = await this.purgeRefreshTokenBatches((q) => q.lt('expires_at', agora.toISOString()));
    const revogadosAntigos = await this.purgeRefreshTokenBatches((q) =>
      q.eq('revoked', true).lt('created_at', limiteRevogados),
    );
    const total = expirados + revogadosAntigos;
    if (total > 0) {
      this.logger.log(
        `Refresh tokens apagados: ${total} (${expirados} expirados, ${revogadosAntigos} revogados há mais de ${Math.round(janelaMs / 60_000)} min).`,
      );
    }
    return total;
  }

  private purgeRefreshTokenBatches(filtro: (q: any) => any): Promise<number> {
    return this.purgeBatches('refresh_tokens', filtro, 'delete');
  }

  /**
   * Apaga registros de auditoria mais antigos que `dataRetention.auditLogDays` (padrão 90). Sem isso a
   * tabela só cresce (login, falha de login, upload, exclusão...). Em lotes: um acúmulo grande é drenado
   * nas próximas execuções horárias.
   */
  async purgeOldAuditLogs(): Promise<number> {
    const dias = this.config.get<number>('dataRetention.auditLogDays') ?? 90;
    const limite = new Date(Date.now() - dias * 86_400_000).toISOString();
    const apagados = await this.purgeBatches('audit_logs', (q) => q.lt('created_at', limite), 'delete');
    if (apagados > 0) this.logger.log(`Registros de auditoria apagados: ${apagados} (mais antigos que ${dias} dias).`);
    return apagados;
  }

  /**
   * Zera `analyses.raw_response` (a resposta bruta da IA, só para depuração) das análises mais antigas que
   * `dataRetention.rawResponseDays` (padrão 30). O resultado estruturado (resumo, checklist, sugestões)
   * continua intacto. É a maior fatia do espaço de cada análise.
   */
  async purgeOldRawResponses(): Promise<number> {
    const dias = this.config.get<number>('dataRetention.rawResponseDays') ?? 30;
    const limite = new Date(Date.now() - dias * 86_400_000).toISOString();
    const zerados = await this.purgeBatches(
      'analyses',
      (q) => q.lt('created_at', limite).not('raw_response', 'is', null),
      'clear_raw_response',
    );
    if (zerados > 0) this.logger.log(`Respostas brutas da IA zeradas: ${zerados} (mais antigas que ${dias} dias).`);
    return zerados;
  }

  /**
   * Lotes de até 100 ids (a URL do DELETE/UPDATE leva os ids), até 50 lotes por passada. Um erro do banco
   * interrompe a passada sem lançar: a próxima execução (1 h depois) continua de onde parou.
   */
  private async purgeBatches(
    tabela: string,
    filtro: (q: any) => any,
    acao: 'delete' | 'clear_raw_response',
  ): Promise<number> {
    const TAMANHO_LOTE = 100;
    const MAX_LOTES = 50;
    let afetados = 0;

    for (let lote = 0; lote < MAX_LOTES; lote++) {
      const { data, error } = await filtro(this.db().from(tabela).select('id')).limit(TAMANHO_LOTE);

      if (error) {
        this.logger.error(`Falha ao listar ${tabela} para limpeza: ${error.message}`);
        break;
      }
      if (!data || data.length === 0) break;

      const ids = data.map((t: { id: string }) => t.id);
      const { error: writeError } =
        acao === 'delete'
          ? await this.db().from(tabela).delete().in('id', ids)
          : await this.db().from(tabela).update({ raw_response: null }).in('id', ids);

      if (writeError) {
        this.logger.error(`Falha ao limpar ${tabela}: ${writeError.message}`);
        break;
      }
      afetados += data.length;
      if (data.length < TAMANHO_LOTE) break;
    }
    return afetados;
  }
}
