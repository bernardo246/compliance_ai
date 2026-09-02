import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';

/**
 * Fase 2 — bloqueia upload/análise se o usuário não aceitou o Termo de Uso
 * na versão vigente (TERMS_CURRENT_VERSION). Consulta o banco a cada request
 * em vez de confiar apenas no JWT, porque o aceite pode acontecer depois do
 * token já ter sido emitido.
 */
@Injectable()
export class TermsAcceptedGuard implements CanActivate {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      // JwtAuthGuard já deveria ter barrado antes; guarda defensiva.
      throw new ForbiddenException('Usuário não autenticado.');
    }

    const { data, error } = await this.supabase
      .getClient()
      .from('users')
      .select('terms_accepted, terms_version')
      .eq('id', user.id)
      .single();

    if (error || !data) {
      throw new ForbiddenException('Não foi possível verificar o aceite do Termo de Uso.');
    }

    const currentVersion = this.config.get<string>('terms.currentVersion');

    if (!data.terms_accepted || data.terms_version !== currentVersion) {
      throw new ForbiddenException(
        'É necessário aceitar o Termo de Uso e Política de Privacidade (versão atual) antes de continuar.',
      );
    }

    return true;
  }
}
