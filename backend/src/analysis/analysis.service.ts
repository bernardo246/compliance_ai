import { Injectable, Logger } from '@nestjs/common';
import { AreaNegocio } from '../documents/dto/upload-document.dto';
import { TipoDocumento } from '../documents/documents.types';
import { ExtractionService } from './extraction.service';
import { OpenRouterClient } from './openrouter.client';
import { getPromptTemplate } from './prompts';
import { AnalysisResult, AnalysisResultSchema } from './schemas/analysis-result.schema';

export class InvalidAnalysisResponseError extends Error {
  constructor(
    message: string,
    public readonly rawResponse: string,
  ) {
    super(message);
    this.name = 'InvalidAnalysisResponseError';
  }
}

@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);

  constructor(
    private readonly extraction: ExtractionService,
    private readonly openRouter: OpenRouterClient,
  ) {}

  /**
   * Função central da Fase 4: recebe um documento já extraído do Storage
   * (buffer + tipo) e a área de negócio escolhida no upload, e retorna o
   * resultado de análise já validado estruturalmente.
   *
   * Propositalmente NÃO toca no banco (Supabase) — isso é responsabilidade
   * da Fase 5 (pipeline assíncrono + persistência). Aqui a função é pura o
   * suficiente para ser testada isoladamente com um documento de teste,
   * como pede o critério de pronto da Fase 4.
   */
  async analyze(
    buffer: Buffer,
    tipo: TipoDocumento,
    areaNegocio: AreaNegocio,
  ): Promise<AnalysisResult> {
    const template = getPromptTemplate(areaNegocio);
    const content = await this.extraction.extractText(buffer, tipo);

    this.logger.log(
      `Analisando documento tipo=${tipo} area=${areaNegocio} template_versao=${template.versao} (${content.length} caracteres extraídos)`,
    );

    const rawResponse = await this.openRouter.chatJson(template.systemPrompt, content);
    return this.parseAndValidate(rawResponse);
  }

  /**
   * A API do modelo pode, em casos raros, envolver o JSON em markdown
   * (```json ... ```) mesmo quando instruída a não fazer isso — por isso
   * limpamos antes de parsear. Depois, validamos estruturalmente com Zod:
   * nunca confiamos "cegamente" na resposta da IA antes de persistir
   * (seção 8 da spec).
   */
  private parseAndValidate(rawResponse: string): AnalysisResult {
    const cleaned = this.stripMarkdownFences(rawResponse);

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(cleaned);
    } catch {
      throw new InvalidAnalysisResponseError(
        'A resposta da IA não é um JSON válido.',
        rawResponse,
      );
    }

    const result = AnalysisResultSchema.safeParse(parsedJson);
    if (!result.success) {
      const issues = result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
      throw new InvalidAnalysisResponseError(
        `A resposta da IA não seguiu o schema esperado: ${issues}`,
        rawResponse,
      );
    }

    return result.data;
  }

  private stripMarkdownFences(text: string): string {
    const trimmed = text.trim();
    const fenceMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
    return fenceMatch ? fenceMatch[1] : trimmed;
  }
}
