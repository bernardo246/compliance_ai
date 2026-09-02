import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * Wrapper fino em torno do client do Supabase.
 *
 * Usa a service_role key porque o backend faz a checagem de autorização
 * (dono do recurso / role) em código próprio antes de tocar no banco —
 * o RLS no Postgres continua ativo como segunda camada de defesa caso
 * algum acesso direto ao banco escape do backend (ex.: query manual,
 * outro serviço), mas não é a única linha de defesa aqui.
 */
@Injectable()
export class SupabaseService {
  private readonly client: SupabaseClient;

  constructor(private readonly config: ConfigService) {
    const url = this.config.get<string>('supabase.url');
    const key = this.config.get<string>('supabase.serviceRoleKey');

    if (!url || !key) {
      // Falha alto e cedo: sem Supabase configurado nada no app funciona.
      throw new Error(
        'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY não configurados no .env',
      );
    }

    this.client = createClient(url, key, {
      auth: { persistSession: false },
    });
  }

  getClient(): SupabaseClient {
    return this.client;
  }
}
