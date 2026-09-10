import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: { total_tokens?: number };
  error?: { message?: string; code?: number };
}

export interface ChatJsonResult {
  /** Conteúdo textual da resposta (deve ser JSON, mas ainda não validado). */
  content: string;
  /** Slug do modelo que efetivamente respondeu. */
  model: string;
  /** Total de tokens (prompt + completion), quando o provider reporta. */
  tokensUsed: number | null;
}

/**
 * Wrapper fino em torno da API da OpenRouter (compatível com o formato
 * chat-completions da OpenAI). Implementado com `fetch` puro em vez de um
 * SDK dedicado, para manter a dependência mínima — é uma única chamada HTTP.
 *
 * IMPORTANTE: o slug do modelo (`OPENROUTER_MODEL` no .env) precisa ser
 * confirmado em https://openrouter.ai/models antes de usar — a
 * disponibilidade e os nomes exatos dos modelos gratuitos mudam com o tempo.
 */
@Injectable()
export class OpenRouterClient {
  private readonly logger = new Logger(OpenRouterClient.name);

  constructor(private readonly config: ConfigService) {}

  async chatJson(systemPrompt: string, userContent: string): Promise<ChatJsonResult> {
    const apiKey = this.config.get<string>('openrouter.apiKey');
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY não configurada no .env');
    }

    const model = this.config.get<string>('openrouter.model')!;
    const maxTokens = this.config.get<number>('openrouter.maxTokens')!;
    const timeoutMs = this.config.get<number>('openrouter.timeoutMs')!;
    const maxRetries = this.config.get<number>('openrouter.maxRetries')!;
    const siteUrl = this.config.get<string>('openrouter.siteUrl');
    const siteName = this.config.get<string>('openrouter.siteName');

    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
    // Cabeçalhos opcionais recomendados pela OpenRouter para atribuição/ranking
    // do app no diretório deles — não afetam o funcionamento da chamada.
    if (siteUrl) headers['HTTP-Referer'] = siteUrl;
    if (siteName) headers['X-Title'] = siteName;

    const body = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      max_tokens: maxTokens,
      temperature: 0, // determinístico — queremos consistência numa análise de compliance
      // Nem todo modelo/provedor por trás da OpenRouter respeita este campo;
      // por isso o prompt também instrui explicitamente "responda só JSON",
      // e o parsing do lado do backend é tolerante (ver AnalysisService).
      response_format: { type: 'json_object' },
    });

    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const res = await fetch(OPENROUTER_URL, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });

        const data = (await res.json().catch(() => null)) as ChatCompletionResponse | null;

        // A OpenRouter às vezes devolve HTTP 200 com o erro no corpo (ex.: falha
        // do provider upstream por trás do modelo). O status HTTP a considerar
        // nesse caso é o `error.code` do corpo, não o `res.status`.
        const errorInBody = data?.error;
        const effectiveStatus = errorInBody?.code ?? res.status;

        if (!res.ok || errorInBody) {
          const message = errorInBody?.message ?? `HTTP ${res.status}`;
          // Erros 4xx (exceto 429) não se beneficiam de retry — a requisição
          // em si está errada (chave inválida, modelo inexistente, etc.).
          if (effectiveStatus < 500 && effectiveStatus !== 429) {
            throw new Error(`OpenRouter recusou a requisição: ${message}`);
          }
          throw new Error(`OpenRouter indisponível (${effectiveStatus}): ${message}`);
        }

        const content = data?.choices?.[0]?.message?.content;
        if (!content) {
          // Log da resposta bruta pra diagnóstico: provider que ignora
          // response_format, resposta só com reasoning tokens, etc.
          this.logger.warn(
            `Resposta sem content. Corpo bruto: ${JSON.stringify(data).slice(0, 1500)}`,
          );
          throw new Error('Resposta da OpenRouter sem conteúdo de mensagem.');
        }

        // `length` = a resposta foi truncada pelo max_tokens e o JSON vai vir
        // incompleto. Não adianta tentar de novo (seria idêntico) — avisa alto
        // pra quem estiver rodando aumentar OPENROUTER_MAX_TOKENS.
        if (data?.choices?.[0]?.finish_reason === 'length') {
          this.logger.warn(
            'A IA truncou a resposta (finish_reason=length). Aumente OPENROUTER_MAX_TOKENS.',
          );
        }

        return { content, model, tokensUsed: data?.usage?.total_tokens ?? null };
      } catch (err) {
        lastError = err;
        const isLastAttempt = attempt === maxRetries;
        this.logger.warn(
          `Tentativa ${attempt + 1}/${maxRetries + 1} de chamada à OpenRouter falhou: ${
            err instanceof Error ? err.message : err
          }`,
        );
        if (!isLastAttempt) {
          // Backoff exponencial simples: 500ms, 1000ms, 2000ms...
          await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
        }
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new ServiceUnavailableException(
      `Falha ao chamar a API de IA após ${maxRetries + 1} tentativa(s): ${
        lastError instanceof Error ? lastError.message : lastError
      }`,
    );
  }
}
