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
    const parsedJson = this.parseJsonLoose(rawResponse);
    if (parsedJson === undefined) {
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

  /**
   * Tenta extrair um objeto JSON da resposta do modelo, tolerando os defeitos
   * mais comuns de modelos grátis: cercas de markdown, texto solto antes/depois
   * do objeto, e a chave de abertura duplicada (`{{`) que alguns providers da
   * OpenRouter injetam quando `response_format: json_object` está ligado.
   *
   * Gera candidatos e devolve o primeiro que `JSON.parse` aceitar — nunca
   * "conserta" o JSON às cegas, só tenta recortes plausíveis. Retorna
   * `undefined` se nenhum candidato for válido.
   */
  private parseJsonLoose(raw: string): unknown {
    let text = raw.trim();

    const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
    if (fence) text = fence[1].trim();

    const candidates = new Set<string>();
    candidates.add(text);

    // Texto solto fora do objeto: recorta do primeiro "{" ao último "}".
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first !== -1 && last > first) {
      candidates.add(text.slice(first, last + 1));

      // Chave de abertura duplicada ("{\n{ \"resumo\"...") — alguns providers
      // da OpenRouter injetam um "{" e o modelo escreve outro em seguida.
      // Recorta a partir da SEGUNDA chave (não colapsa a do fim às cegas,
      // porque "...}}" costuma ser um objeto aninhado legítimo no final).
      if (/^\{\s*\{/.test(text)) {
        const second = text.indexOf('{', first + 1);
        candidates.add(text.slice(second, last + 1));
        // Se a duplicação for simétrica ("{{ ... }}"), recorta as duas pontas.
        if (/\}\s*\}\s*$/.test(text)) {
          candidates.add(text.slice(second, text.lastIndexOf('}', last - 1) + 1));
        }
      }
    }

    for (const candidate of candidates) {
      try {
        return JSON.parse(candidate);
      } catch {
        // tenta o próximo candidato
      }
    }
    return undefined;
  }
}
