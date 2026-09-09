import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
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

  async chatJson(systemPrompt: string, userContent: string): Promise<string> {
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

        if (!res.ok) {
          const message = data?.error?.message ?? `HTTP ${res.status}`;
          // Erros 4xx (exceto 429) não se beneficiam de retry — a requisição
          // em si está errada (chave inválida, modelo inexistente, etc.).
          if (res.status < 500 && res.status !== 429) {
            throw new Error(`OpenRouter recusou a requisição: ${message}`);
          }
          throw new Error(`OpenRouter indisponível (${res.status}): ${message}`);
        }

        const content = data?.choices?.[0]?.message?.content;
        if (!content) {
          throw new Error('Resposta da OpenRouter sem conteúdo de mensagem.');
        }

        return content;
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
