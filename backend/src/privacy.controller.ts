import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Public } from './common/decorators/public.decorator';

/**
 * Informação pública para o Termo de Uso: o provedor de IA pode usar o conteúdo dos documentos para
 * treino? É `true` quando OPENROUTER_DATA_COLLECTION=allow (necessário para usar modelos ":free").
 * O frontend lê isto para o texto do termo nunca prometer o que o backend não cumpre.
 */
@Controller('api/privacy-info')
export class PrivacyController {
  constructor(private readonly config: ConfigService) {}

  @Public()
  @Get()
  info() {
    return { ia_treino_permitido: this.config.get<string>('openrouter.dataCollection') === 'allow' };
  }
}
