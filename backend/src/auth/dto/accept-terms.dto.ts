import { IsString } from 'class-validator';

/**
 * O cliente envia a versão que está exibindo na tela; o AuthService confirma
 * que bate com TERMS_CURRENT_VERSION (via ConfigService) antes de gravar o
 * aceite — evita que um frontend desatualizado registre aceite de versão antiga.
 */
export class AcceptTermsDto {
  @IsString()
  version!: string;
}
