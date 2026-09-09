export default () => ({
  port: parseInt(process.env.PORT ?? '3001', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  frontendUrl: process.env.FRONTEND_URL ?? 'http://localhost:3000',

  supabase: {
    url: process.env.SUPABASE_URL ?? '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    storageBucket: process.env.SUPABASE_STORAGE_BUCKET ?? 'documents',
  },

  jwt: {
    // As chaves ficam com \n escapados no .env; aqui convertemos de volta.
    privateKey: (process.env.JWT_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
    publicKey: (process.env.JWT_PUBLIC_KEY ?? '').replace(/\\n/g, '\n'),
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '7d',
  },

  terms: {
    currentVersion: process.env.TERMS_CURRENT_VERSION ?? '1.0.0',
  },

  upload: {
    maxSizeMb: parseInt(process.env.MAX_UPLOAD_SIZE_MB ?? '20', 10),
    allowedMimeTypes: [
      'application/pdf',
      'text/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
  },

  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY ?? '',
    // ⚠️ Confirme o slug exato do modelo em https://openrouter.ai/models
    // (filtre por "free") antes de usar — o valor abaixo é só um palpite
    // informado e pode não existir mais no catálogo deles quando você ler isso.
    model: process.env.OPENROUTER_MODEL ?? 'nvidia/nemotron-nano-9b-v2:free',
    maxTokens: parseInt(process.env.OPENROUTER_MAX_TOKENS ?? '8000', 10),
    // Seção 8 da spec: timeout + retry com backoff para chamadas à API de IA.
    timeoutMs: parseInt(process.env.OPENROUTER_TIMEOUT_MS ?? '120000', 10),
    maxRetries: parseInt(process.env.OPENROUTER_MAX_RETRIES ?? '2', 10),
    // Cabeçalhos opcionais recomendados pela OpenRouter para atribuição/analytics.
    siteUrl: process.env.OPENROUTER_SITE_URL ?? '',
    siteName: process.env.OPENROUTER_SITE_NAME ?? '',
  },
});
