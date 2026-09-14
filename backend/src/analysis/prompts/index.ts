import { BadRequestException } from '@nestjs/common';
import { AreaNegocio } from '../../documents/dto/upload-document.dto';
import { JURIDICO_PROMPT } from './juridico.prompt';
import { FINANCAS_PROMPT } from './financas.prompt';
import { IMOBILIARIO_PROMPT } from './imobiliario.prompt';
import { RH_PROMPT } from './rh.prompt';
import { SAUDE_PROMPT } from './saude.prompt';
import { OUTRO_PROMPT } from './outro.prompt';

export interface PromptTemplate {
  areaNegocio: AreaNegocio;
  versao: string;
  atualizadoEm: string;
  systemPrompt: string;
}

/**
 * Fase 9 — todas as 6 áreas de negócio têm template próprio, cada um com o
 * mesmo rigor da seção 6.2 da spec (checklist exaustivo, compliance
 * regulatório explícito quando aplicável, anti-alucinação, nenhuma lacuna
 * silenciosa, schema JSON rígido) e validado por golden set próprio
 * (`npm run golden:build` / `golden:test`, seção 5 do README).
 */
const TEMPLATES: Record<AreaNegocio, PromptTemplate> = {
  juridico: JURIDICO_PROMPT,
  financas: FINANCAS_PROMPT,
  imobiliario: IMOBILIARIO_PROMPT,
  rh: RH_PROMPT,
  saude: SAUDE_PROMPT,
  outro: OUTRO_PROMPT,
};

export function getPromptTemplate(areaNegocio: AreaNegocio): PromptTemplate {
  const template = TEMPLATES[areaNegocio];

  if (!template) {
    // Só alcançável se um novo valor for adicionado a AREAS_NEGOCIO sem
    // template correspondente — guarda defensiva, não um caminho esperado.
    throw new BadRequestException(
      `Ainda não há template de análise para a área "${areaNegocio}".`,
    );
  }

  return template;
}
