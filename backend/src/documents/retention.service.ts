import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SupabaseService } from '../common/supabase/supabase.service';

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
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
  ) {}

  private db() {
    return this.supabase.getClient();
  }

  @Cron(CronExpression.EVERY_HOUR)
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
}
