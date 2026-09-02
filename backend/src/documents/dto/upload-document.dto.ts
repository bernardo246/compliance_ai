import { IsIn } from 'class-validator';

export const AREAS_NEGOCIO = [
  'financas',
  'juridico',
  'imobiliario',
  'rh',
  'saude',
  'outro',
] as const;

export type AreaNegocio = (typeof AREAS_NEGOCIO)[number];

export class UploadDocumentDto {
  @IsIn(AREAS_NEGOCIO, {
    message: `area_negocio deve ser um dos seguintes valores: ${AREAS_NEGOCIO.join(', ')}`,
  })
  area_negocio!: AreaNegocio;
}
