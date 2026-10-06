import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { REDIS_CLIENT } from '../redis/redis.constants';
import { SupabaseService } from '../supabase/supabase.service';

// Só o resultado POSITIVO (já aceitou) é guardado. A chave inclui a versão do
// termo: ao publicar uma versão nova, ninguém tem a chave e todos são
// reavaliados no banco.
const TERMS_OK_TTL_SECONDS = 300;

/**
 * Fase 2 — bloqueia upload/análise se o usuário não aceitou o Termo de Uso
 * na versão vigente (TERMS_CURRENT_VERSION). Consulta o banco a cada request
 * em vez de confiar apenas no JWT, porque o aceite pode acontecer depois do
 * token já ter sido emitido.
 *
 * Esta checagem roda em TODA requisição de documentos (inclusive cada polling
 * da tela), e o resultado é sempre o mesmo para o mesmo usuário: por isso o
 * "já aceitou" é guardado no Redis por alguns minutos, tirando uma consulta
 * ao banco de cada requisição. Se a leitura do cache falhar, cai para o banco
 * (o rate limit já depende do Redis antes de chegar aqui: uma queda longa dele
 * trava a requisição antes deste guard, com ou sem este cache).
 */
@Injectable()
export class TermsAcceptedGuard implements CanActivate {
  private readonly logger = new Logger(TermsAcceptedGuard.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      // JwtAuthGuard já deveria ter barrado antes; guarda defensiva.
      throw new ForbiddenException('Usuário não autenticado.');
    }

    const currentVersion = this.config.get<string>('terms.currentVersion');
    const cacheKey = `terms:ok:${user.id}:${currentVersion}`;

    try {
      if (await this.redis.get(cacheKey)) return true;
    } catch (err) {
      this.logger.warn(`Cache de termos indisponível, consultando o banco: ${err instanceof Error ? err.message : err}`);
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

    if (!data.terms_accepted || data.terms_version !== currentVersion) {
      throw new ForbiddenException(
        'É necessário aceitar o Termo de Uso e Política de Privacidade (versão atual) antes de continuar.',
      );
    }

    try {
      await this.redis.set(cacheKey, '1', 'EX', TERMS_OK_TTL_SECONDS);
    } catch {
      // sem cache: a próxima requisição só consulta o banco de novo
    }
    return true;
  }
}
