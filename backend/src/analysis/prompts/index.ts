import { BadRequestException } from '@nestjs/common';
import { AreaNegocio } from '../../documents/dto/upload-document.dto';
import { JURIDICO_PROMPT } from './juridico.prompt';

export interface PromptTemplate {
  areaNegocio: AreaNegocio;
  versao: string;
  atualizadoEm: string;
  systemPrompt: string;
}

/**
 * Fase 4 implementa apenas o piloto (`juridico`), conforme a spec pede
 * ("provar o pipeline ponta a ponta com uma única área de negócio").
 * As demais áreas ganham seus templates na Fase 9 ("Expansão de Templates"),
 * com o mesmo rigor de checklist exaustivo + compliance regulatório.
 */
const TEMPLATES: Partial<Record<AreaNegocio, PromptTemplate>> = {
  juridico: JURIDICO_PROMPT,
};

export function getPromptTemplate(areaNegocio: AreaNegocio): PromptTemplate {
  const template = TEMPLATES[areaNegocio];

  if (!template) {
    throw new BadRequestException(
      `Ainda não há template de análise para a área "${areaNegocio}" ` +
        `(implementado apenas "juridico" nesta fase — as demais áreas chegam na Fase 9).`,
    );
  }

  return template;
}
