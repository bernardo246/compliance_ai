import { Injectable, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../common/supabase/supabase.service';

/**
 * Leitura de análises já persistidas (Fase 5). A autorização é por dono:
 * uma análise só é visível para o usuário dono do documento associado
 * (o join `documents!inner` + filtro por `user_id` garante isso).
 */
@Injectable()
export class AnalysisReadService {
  constructor(private readonly supabase: SupabaseService) {}

  private db() {
    return this.supabase.getClient();
  }

  /** Resultado da análise pelo id da própria análise. */
  async findByIdForUser(userId: string, analysisId: string) {
    const { data, error } = await this.db()
      .from('analyses')
      .select('*, documents!inner(id, user_id, nome_original, area_negocio, tipo, status)')
      .eq('id', analysisId)
      .eq('documents.user_id', userId)
      .maybeSingle();

    if (error || !data) {
      throw new NotFoundException('Análise não encontrada.');
    }
    return data;
  }

  /**
   * Análise de um documento (ou `null` se ainda não há). Usado para embutir a
   * análise no detalhe do documento, para o frontend consultar status +
   * resultado numa chamada só.
   */
  async findByDocument(documentId: string) {
    const { data } = await this.db()
      .from('analyses')
      .select('*')
      .eq('document_id', documentId)
      .maybeSingle();

    return data ?? null;
  }
}
