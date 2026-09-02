# Especificação Técnica — Plataforma de Análise de Documentos e Dados com IA

## 1. Visão Geral

Plataforma web que permite ao usuário enviar **documentos (PDF)** e/ou **planilhas (CSV/XLSX)**, que são analisados pela **API do Claude (Anthropic)**. O sistema retorna insights, inconsistências, riscos e — como requisito central do produto — **recomendações de melhoria e correção** com base no conteúdo analisado.

**Posicionamento do produto:** mais do que uma revisão genérica, a plataforma atua como uma **camada de compliance por nicho** — ou seja, cada documento/planilha é avaliado não só por consistência interna, mas **contra os padrões, normas e obrigações legais/regulatórias do respectivo setor** (ex.: um contrato jurídico é checado contra dispositivos do Código Civil/CDC aplicáveis; uma planilha financeira contra boas práticas contábeis; um documento imobiliário contra exigências de registro/cartório; um documento de RH contra a CLT; um documento de saúde contra normas administrativas do setor). Isso é o que diferencia a ferramenta de um "revisor de texto genérico com IA" — o resultado da análise deve indicar, item a item, se o documento está **em conformidade, em risco, ou não verificável** frente ao arcabouço daquele nicho.

> **Importante — limite de responsabilidade:** a plataforma **auxilia** na identificação de riscos de compliance, mas não substitui parecer jurídico/contábil/técnico profissional. Isso deve estar explícito no Termo de Uso (seção 3.3) e, idealmente, replicado como aviso no próprio resultado da análise.

A plataforma terá cadastro/login próprio, com autenticação e autorização via API REST, e usará **Supabase** como banco de dados (Postgres) e, opcionalmente, storage de arquivos.

> **Decisão de escopo (nicho):** o documento cobre uma arquitetura única que suporta os dois modos de análise (documentos e planilhas), pois tecnicamente compartilham 90% do pipeline (upload → extração → prompt para Claude → parsing da resposta → persistência → sugestões). Em vez de fixar um único nicho no código, o usuário **seleciona a área de atuação do documento no momento do upload** (ex.: Finanças, Jurídico, Imobiliário, RH), e essa escolha direciona automaticamente qual prompt/template de análise será usado — ver seção 6.1.

| Modo | Entrada | Saída principal |
|---|---|---|
| Revisão de documentos | PDF (contrato, laudo, relatório) | Cláusulas de risco, dados faltantes, inconsistências, **sugestões de correção** |
| Análise de dados | CSV/XLSX | Tendências, outliers, resumo executivo, **sugestões de melhoria** |

**Área de atuação (`area_negocio`):** campo obrigatório no upload, com valores enumerados (ex.: `financas`, `juridico`, `imobiliario`, `rh`, `saude`, `outro`). Ele funciona como **seletor de template de prompt**: cada área tem um system prompt específico, calibrado com a terminologia e os critérios de risco daquele domínio (ex.: "jurídico" foca em cláusulas abusivas e prazos; "financas" foca em outliers e fluxo de caixa; "imobiliario" foca em metragem, matrícula, ônus). Isso evita ter que criar múltiplas aplicações — é uma única plataforma com N templates de análise.

---

## 2. Arquitetura Geral

```
[ Frontend (SPA) ]
        │  HTTPS (TLS 1.2+)
        ▼
[ API REST — Backend ] ── autentica/autoriza (JWT) ──▶ [ Supabase (Postgres + Auth + Storage) ]
        │
        ▼
[ Serviço de Análise ] ── chama ──▶ [ Anthropic Claude API ]
        │
        ▼
[ Persistência do resultado + sugestões ] ──▶ Supabase
```

**Stack sugerida:**
- **Frontend:** Next.js (React) + TypeScript
- **Backend (API REST):** Node.js (NestJS recomendado, alternativa: Express) — NestJS pela estrutura modular (guards, interceptors nativos para JWT/RBAC, injeção de dependência)
- **Banco de dados:** Supabase (PostgreSQL gerenciado) + Supabase Storage (arquivos) + Supabase Row Level Security (RLS)
- **IA:** Anthropic Claude API (endpoint `/v1/messages`), com suporte a `document` (PDF) e `text` (CSV/planilha convertida)
- **Fila/assíncrono (recomendado):** processamento de análise em background (ex.: BullMQ/Redis) — análises podem levar segundos e não devem travar a requisição HTTP

---

## 3. Autenticação e Autorização (API REST)

### 3.1 Autenticação
- **JWT (JSON Web Token)** como mecanismo principal:
  - **Access Token**: curta duração (10–15 min), enviado no header `Authorization: Bearer <token>`
  - **Refresh Token**: duração maior (7 dias), **httpOnly + Secure cookie** (nunca em localStorage) — evita roubo via XSS
  - Rotação de refresh token a cada uso (refresh token rotation) para mitigar reuso de token vazado
  - Assinatura via **RS256** (par de chaves assimétricas), não HS256, para permitir validação por múltiplos serviços sem expor a chave privada
- **Senhas:** hash com **bcrypt** (custo ≥ 12) ou **argon2id** — nunca armazenar em texto plano
- Opção de usar o **Supabase Auth** nativo (já entrega JWT, refresh, e recuperação de senha prontos) em vez de implementar auth do zero — reduz superfície de erro
- **MFA (2FA)** opcional via TOTP para contas com dados sensíveis (ex.: jurídico)

### 3.2 Autorização
- **RBAC (Role-Based Access Control)**: papéis mínimos — `user`, `admin`
- **Row Level Security (RLS)** no Supabase: cada usuário só acessa suas próprias análises/documentos (`user_id = auth.uid()`)
- Middleware/guard no backend valida o JWT **e** verifica escopo/role antes de liberar rotas sensíveis (ex.: exclusão de documentos, endpoints administrativos)

### 3.3 Termo de Uso (aceite obrigatório)
- No cadastro (ou antes do primeiro upload), o usuário deve **aceitar explicitamente o Termo de Uso e Política de Privacidade** — o aceite é condição bloqueante: sem `terms_accepted = true`, a rota de upload retorna erro.
- O aceite é versionado (`terms_version`) e datado (`terms_accepted_at`), para que, se o termo mudar no futuro, o sistema saiba pedir um novo aceite.
- O termo deve deixar explícito, em linguagem clara: (a) que o arquivo é enviado a um serviço de IA de terceiro (Anthropic) para análise; (b) que o arquivo original é armazenado de forma criptografada por **até 72 horas** e depois excluído automaticamente; (c) que apenas o resultado da análise (JSON) permanece armazenado após esse prazo; (d) o direito do usuário de solicitar exclusão antecipada.
- Esse aceite é o que dá amparo legal (LGPD) para reter o arquivo original por um período curto, mesmo sendo dado potencialmente sensível.

### 3.4 Segurança adicional na camada de API
- **Rate limiting** por IP e por usuário (ex.: `express-rate-limit` ou API Gateway) — protege contra brute force no login e abuso da análise (que tem custo de API de IA)
- **CORS** restrito a domínios conhecidos do frontend
- **Helmet.js** (ou equivalente) para headers HTTP seguros (CSP, X-Frame-Options, HSTS)
- **CSRF protection** se houver uso de cookies para sessão
- Validação e sanitização de entrada em **todas** as rotas (ex.: `zod`, `class-validator`)
- Logs de auditoria: login, falhas de autenticação, exclusão de dados, downloads de documentos
- **Segredos** (chave da API do Claude, JWT secret, credenciais Supabase) via variáveis de ambiente + gerenciador de secrets (ex.: Vault, ou secrets do provedor de deploy) — nunca no repositório

---

## 4. Segurança no Upload e Armazenamento de Arquivos

- Validação de **tipo MIME real** do arquivo (não confiar só na extensão)
- Limite de tamanho de arquivo (ex.: 20 MB) e limite de páginas/linhas
- Scan antivírus/malware antes de persistir (ex.: ClamAV) — mitiga upload malicioso
- Armazenamento no **Supabase Storage** com bucket privado + política de acesso via RLS/URL assinada (signed URL de curta duração) — nunca bucket público
- Criptografia em repouso (at rest) — padrão do Supabase/Postgres, mas documentar explicitamente para compliance
- **Retenção de 72 horas com deleção automática (job agendado):**
  - O arquivo original permanece no Supabase Storage por no máximo **72h** após o upload
  - Um job agendado (ex.: `pg_cron` do Supabase, ou um worker externo tipo BullMQ/cron) roda periodicamente (ex.: a cada hora) e:
    1. Busca documentos com `created_at < now() - interval '72 hours'` e `storage_path IS NOT NULL`
    2. Remove o arquivo do bucket no Storage
    3. Atualiza o registro em `documents`, limpando `storage_path` e marcando `deletado_em`
  - Isso substitui a deleção manual "por sessão" — o próprio banco garante a limpeza, mesmo que o usuário feche a aba ou nunca volte
  - **Somente o arquivo binário é removido** — o resultado da análise (`analyses`) permanece, pois não contém o documento original, apenas o output estruturado
  - Esse fluxo só é legítimo com o **Termo de Uso aceito previamente** (seção 3.3), que informa ao usuário esse prazo de retenção
- Direito de exclusão antecipada (right to erasure) — endpoint para o usuário apagar o arquivo e/ou a análise antes das 72h, a qualquer momento

---

## 5. Modelagem de Dados (Supabase / Postgres)

```
users
 ├─ id (uuid, pk)
 ├─ email (unique)
 ├─ password_hash        -- se não usar Supabase Auth nativo
 ├─ role (enum: user, admin)
 ├─ terms_accepted (boolean, default false)
 ├─ terms_version (text)          -- versão do termo aceito
 ├─ terms_accepted_at (timestamp)
 ├─ created_at

documents
 ├─ id (uuid, pk)
 ├─ user_id (fk -> users.id)
 ├─ tipo (enum: 'pdf' | 'csv' | 'xlsx')
 ├─ area_negocio (enum: 'financas' | 'juridico' | 'imobiliario' | 'rh' | 'saude' | 'outro')  -- direciona o prompt
 ├─ nome_original
 ├─ storage_path            -- setado NULL após deleção automática em 72h
 ├─ status (enum: 'uploaded' | 'processing' | 'done' | 'error')
 ├─ expira_em (timestamp)   -- created_at + 72h, usado pelo job de limpeza
 ├─ deletado_em (timestamp, nullable)
 ├─ created_at

analyses
 ├─ id (uuid, pk)
 ├─ document_id (fk -> documents.id)
 ├─ resumo_executivo (text)
 ├─ status_compliance_geral (enum: 'conforme' | 'nao_conforme' | 'parcial' | 'nao_verificavel')  -- veredito agregado
 ├─ inconsistencias (jsonb)     -- lista estruturada, cada item com status_compliance/referencia_normativa
 ├─ dados_faltantes (jsonb)
 ├─ outliers_tendencias (jsonb) -- para planilhas
 ├─ sugestoes_melhoria (jsonb)  -- requisito central do produto
 ├─ raw_claude_response (jsonb) -- resposta bruta p/ auditoria/debug
 ├─ created_at

audit_logs
 ├─ id (uuid, pk)
 ├─ user_id (fk)
 ├─ acao (ex: 'login', 'upload', 'delete_document')
 ├─ ip_address
 ├─ created_at
```

**RLS:** políticas em `documents`, `analyses` e `audit_logs` garantindo `user_id = auth.uid()`, exceto para role `admin`.

---

## 6. Fluxo de Análise (Pipeline)

1. Usuário autenticado verifica `terms_accepted = true` (se não, é bloqueado e redirecionado ao aceite do termo)
2. Usuário envia arquivo **+ seleciona a `area_negocio`** (ex.: Jurídico) → `POST /api/documents`
3. Backend valida arquivo (tipo, tamanho, antivírus) e salva no Supabase Storage; grava `expira_em = created_at + 72h`
4. Job assíncrono é disparado (status = `processing`)
5. Backend extrai conteúdo:
   - PDF → enviado como `document` (base64) direto para a API do Claude
   - CSV/XLSX → parseado em Node.js (ex.: `papaparse` para CSV, `SheetJS/xlsx` para XLSX) e enviado como texto estruturado
6. **A `area_negocio` seleciona o system prompt/template correspondente** (seção 6.1) — o mesmo motor de análise, com instruções diferentes por domínio
7. Prompt estruturado é enviado ao Claude solicitando **saída em JSON** com campos fixos:
   - `resumo_executivo`
   - `inconsistencias` / `dados_faltantes` (documentos) ou `tendencias` / `outliers` (planilhas)
   - `sugestoes_melhoria` (**sempre obrigatório** — este é o diferencial pedido)
8. Backend parseia o JSON, salva em `analyses`, atualiza status para `done`
9. Frontend consome `GET /api/analyses/:id` e exibe resultado + sugestões
10. **Job agendado (independente, roda a cada hora):** varre `documents` com `expira_em < now()`, apaga o arquivo do Storage, zera `storage_path`, marca `deletado_em` — sem intervenção manual

### 6.1 Seleção de template por área de negócio

| `area_negocio` | Foco do prompt | Referencial de compliance (exemplos) |
|---|---|---|
| `financas` | Outliers em valores, tendências de receita/despesa, inconsistências entre períodos, sugestões de otimização de custos | Boas práticas contábeis (CPC/normas do CFC), obrigações fiscais básicas, políticas internas de controle financeiro |
| `juridico` | Cláusulas de risco/abusivas, prazos, ausência de cláusulas padrão, sugestões de redação corretiva | Código Civil, Código de Defesa do Consumidor (quando aplicável), Lei de Locações/legislação setorial correspondente ao tipo de contrato |
| `imobiliario` | Metragem, matrícula, ônus/gravames, dados cadastrais faltantes, sugestões de regularização | Lei de Registros Públicos, exigências de matrícula/cartório, normas do CRECI aplicáveis |
| `rh` | Consistência de dados contratuais/benefícios, cláusulas trabalhistas sensíveis, sugestões de conformidade | CLT, normas de eSocial, acordos/convenções coletivas quando informados |
| `saude` | Dados faltantes em laudos, inconsistências clínicas administrativas (não diagnóstico), sugestões de completude | Normas administrativas de prontuário/documentação em saúde (ex.: exigências de completude do CFM/ANS, quando aplicável) |
| `outro` | Template genérico de revisão/análise | Sem referencial regulatório fixo — checklist genérico de boas práticas documentais |

Cada template é um **system prompt versionado** (armazenado em código ou tabela `prompt_templates`), não uma nova aplicação — isso mantém a plataforma extensível para novas áreas sem refatoração estrutural. O referencial de compliance de cada área **não é genérico**: deve ser definido com apoio de alguém com conhecimento no domínio (ou fonte confiável) antes de virar checklist de prompt — ver seção 6.2.

### 6.2 Requisito de qualidade dos templates de prompt (crítico)

Cada template **não pode ser um prompt genérico ou superficial** — ele é o principal ponto de qualidade do produto, já que é o que garante que a análise não deixe passar erros/riscos relevantes do domínio. Todo template deve ser construído seguindo os critérios abaixo:

- **Checklist exaustivo por cenário:** cada template deve conter uma lista explícita e exaustiva do que verificar naquele domínio, não instruções vagas como "aponte riscos". Exemplo — no template `juridico`, listar item a item: cláusulas de rescisão, multas, foro, reajuste, confidencialidade, propriedade intelectual, prazo de vigência, condições de renovação automática, ausência de assinatura/testemunhas, cláusulas leoninas etc. O mesmo rigor vale para `financas` (ex.: divergência entre saldo inicial/final, duplicidade de lançamentos, datas fora de sequência, categorização inconsistente), `imobiliario` (matrícula atualizada, certidões negativas, metragem divergente entre documento e registro, ônus/hipotecas não declarados) e `saude`/`rh` de forma equivalente.
- **Checagem explícita de compliance regulatório:** além de erros de conteúdo, cada item do checklist deve, sempre que aplicável, referenciar a norma/lei/boa prática correspondente (ver referencial da seção 6.1) e classificar o item como `conforme`, `nao_conforme` ou `nao_verificavel` em relação a esse referencial — não apenas "certo/errado" de forma solta. Isso é o que transforma a análise em um relatório de compliance, e não só uma revisão de texto.
- **Nenhuma lacuna silenciosa:** o prompt deve instruir explicitamente o modelo a **declarar quando não encontrar informação suficiente** para avaliar um item do checklist (ex.: `"status": "nao_verificavel", "motivo": "documento não contém a cláusula de reajuste"`), em vez de omitir o item — isso evita falso negativo (parecer que está tudo certo quando só não foi analisado).
- **Formato de saída rígido e obrigatório:** o system prompt deve fixar o schema JSON esperado, com todos os campos e sub-campos obrigatórios (ex.: cada item do checklist vira um objeto com `item`, `status_compliance` [`conforme`/`nao_conforme`/`nao_verificavel`], `referencia_normativa`, `severidade` [`baixa`/`media`/`alta`/`critica`], `evidencia` e `sugestao_correcao`) — isso facilita validação estrutural no backend e reduz risco do modelo "resumir demais" e esconder um problema real.
- **Instrução anti-alucinação:** o prompt deve deixar explícito que o modelo só pode afirmar algo com base no conteúdo real do documento/planilha enviado, citando o trecho/linha de evidência — proibido inferir dados que não estão no material.
- **Cobertura de vulnerabilidades específicas do domínio:** além de erros de conteúdo, o template deve orientar o modelo a sinalizar padrões associados a fraude/vulnerabilidade daquele nicho (ex.: `juridico` — cláusulas ocultas/ambíguas usadas para lesar uma das partes; `financas` — indícios de lançamentos fictícios ou manipulação de números; `imobiliario` — inconsistência entre proprietário declarado e registro em cartório).
- **Revisão e versionamento contínuo:** cada template deve ter um responsável (ou processo) de revisão periódica — a lista de verificações de um domínio muda com legislação/prática de mercado, então o `prompt_templates` precisa suportar múltiplas versões (`versao`, `atualizado_em`) e permitir atualizar o checklist sem quebrar análises já feitas com versões anteriores.
- **Testes com casos conhecidos:** antes de subir um template novo/atualizado para produção, ele deve ser validado contra um conjunto de documentos de teste com problemas conhecidos (golden set) — garantindo que o modelo realmente captura os erros esperados antes de confiar no template com usuários reais.

---

## 7. Principais Endpoints da API REST

| Método | Rota | Descrição | Auth |
|---|---|---|---|
| POST | `/api/auth/register` | Cadastro de usuário | Público |
| POST | `/api/auth/login` | Login (retorna access + refresh token) | Público |
| POST | `/api/auth/refresh` | Renova access token | Refresh token |
| POST | `/api/auth/logout` | Revoga refresh token | JWT |
| POST | `/api/auth/accept-terms` | Registra aceite do Termo de Uso (versão + timestamp) | JWT |
| POST | `/api/documents` | Upload de documento/planilha (body inclui `area_negocio`) — bloqueado se termo não aceito | JWT |
| GET | `/api/documents` | Lista documentos do usuário | JWT |
| GET | `/api/documents/:id` | Detalhe do documento | JWT |
| DELETE | `/api/documents/:id` | Remove documento (LGPD) | JWT |
| GET | `/api/analyses/:id` | Resultado da análise + sugestões | JWT |
| GET | `/api/admin/users` | Gestão de usuários | JWT + role admin |

---

## 8. Considerações sobre a API do Claude

- Usar o endpoint `/v1/messages` com **structured output em JSON** (instruir explicitamente no system prompt: "responda apenas com JSON válido, sem texto adicional")
- Definir **timeout e retry** (ex.: 2 tentativas com backoff) para chamadas à API
- Monitorar custo: cada análise consome tokens proporcionalmente ao tamanho do PDF/planilha — considerar **limite de uso por plano** (ex.: X análises/mês no plano gratuito)
- Chave da API do Claude fica **exclusivamente no backend** — nunca exposta ao frontend
- Sempre validar/sanitizar a resposta da IA antes de persistir (ela pode, em casos raros, não seguir o formato solicitado)

---

## 9. Compliance e Privacidade

- **LGPD:** política de privacidade clara, consentimento explícito no cadastro, opção de exportar/apagar dados
- **Termo de Uso com aceite obrigatório** (bloqueante) é a base legal para reter o arquivo original por até 72h — sem esse aceite, o upload não é permitido
- **Retenção limitada a 72h** com deleção automática via job agendado (seção 4 e 6) — princípio de minimização de dados (LGPD, art. 6º, III), reduzindo a janela de exposição do arquivo original sem abrir mão da possibilidade de reprocessamento em caso de erro
- Dados sensíveis (ex.: laudos médicos, contratos com dados pessoais) exigem atenção redobrada — considerar criptografia adicional a nível de campo para conteúdo extraído, se o nicho for jurídico/RH/saúde
- Logs de auditoria não devem armazenar conteúdo sensível do documento, apenas metadados da ação

---

## 10. Roadmap Sugerido (MVP → Evolução)

1. **MVP:** cadastro/login (Supabase Auth ou JWT próprio) + upload de 1 tipo de arquivo (escolher nicho) + análise via Claude + exibição de resultado e sugestões
2. **V2:** histórico de análises, dashboard com gráficos (para planilhas), exportação de relatório em PDF
3. **V3:** múltiplos nichos configuráveis, MFA, planos pagos com limites de uso, comparação entre análises (ex.: versão anterior vs. atual de um contrato)

---

## 11. Resumo de Segurança (checklist)

- [x] JWT (access curto + refresh rotativo, RS256)
- [x] Hash de senha com bcrypt/argon2id
- [x] RBAC + RLS no Supabase
- [x] Rate limiting (login e uploads)
- [x] CORS restrito + Helmet + HSTS
- [x] Validação de tipo/tamanho de arquivo + antivírus
- [x] Storage privado com signed URLs
- [x] Secrets fora do código-fonte
- [x] Logs de auditoria
- [x] Termo de Uso com aceite obrigatório e versionado, bloqueando upload sem aceite
- [x] Retenção do arquivo original limitada a 72h, com deleção automática via job agendado
- [x] `area_negocio` como campo obrigatório de upload, usado para selecionar o template de prompt
- [x] Templates de prompt exaustivos por cenário (checklist completo, anti-alucinação, schema JSON rígido, versionamento e golden set de testes)
- [x] Resultado da análise estruturado como veredito de compliance por item (`conforme`/`nao_conforme`/`nao_verificavel`) com referência normativa, não apenas revisão de texto genérica
- [x] Aviso explícito de que a análise não substitui parecer profissional (jurídico/contábil/técnico)

## 12. Plano de Construção Faseado
 
Divisão em fases sequenciais, cada uma com escopo fechado e testável isoladamente antes de avançar para a próxima. A ordem respeita dependências técnicas (ex.: não dá pra ter upload sem auth; não dá pra ter job de expiração sem ter upload funcionando).
 
### Fase 0 — Fundamentos e Infraestrutura
**Objetivo:** deixar o esqueleto do projeto rodando, sem lógica de negócio ainda.
- Criar projeto no Supabase (banco, Auth, Storage) e obter as chaves
- Criar repositório backend (NestJS) e frontend (Next.js)
- Configurar variáveis de ambiente (`.env`) e gerenciamento de secrets (nunca commitados)
- Configurar conexão do backend com Supabase (client + teste de leitura simples)
- Configurar CORS, Helmet e estrutura básica de módulos no NestJS
**Critério de pronto:** backend sobe localmente, responde num endpoint de health-check (`GET /api/health`), e consegue ler/escrever um registro de teste no Supabase.
### Fase 1 — Autenticação
**Objetivo:** cadastro, login e emissão/renovação de JWT funcionando de ponta a ponta.
- Tabela `users` (ou uso do Supabase Auth nativo)
- Endpoints: `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`
- Hash de senha (bcrypt/argon2id) se auth for própria
- Emissão de access token (curto) + refresh token (httpOnly cookie, rotativo)
- Guard/middleware de validação de JWT nas rotas protegidas
**Critério de pronto:** dá pra registrar um usuário, logar, receber os tokens, acessar uma rota protegida de teste com o access token, e renovar com o refresh token.
### Fase 2 — Autorização e Termo de Uso
**Objetivo:** RBAC básico + bloqueio de ações sem aceite do termo.
- Campo `role` no usuário e guard de verificação de papel (`user`/`admin`)
- Campos `terms_accepted`, `terms_version`, `terms_accepted_at`
- Endpoint `POST /auth/accept-terms`
- Middleware que bloqueia rotas de upload/análise se `terms_accepted = false`
- RLS no Supabase para as tabelas já existentes
**Critério de pronto:** usuário sem aceite não consegue chamar upload (erro claro retornado); depois de aceitar, a rota libera.
### Fase 3 — Upload de Documentos
**Objetivo:** receber e armazenar arquivos com segurança, sem ainda analisar.
- Tabela `documents` (com `area_negocio`, `expira_em`, `storage_path`, `status`)
- Endpoint `POST /api/documents` (multipart) com `area_negocio` obrigatório
- Validações: tipo MIME real, tamanho máximo, extensão permitida
- Upload para Supabase Storage (bucket privado)
- Endpoint `GET /api/documents` e `GET /api/documents/:id`
**Critério de pronto:** upload de um PDF/CSV de teste funciona, fica salvo no Storage, e aparece corretamente listado para o usuário dono (e não aparece para outro usuário — testar RLS).
### Fase 4 — Integração com a API do Claude (1 template piloto)
**Objetivo:** provar o pipeline de análise ponta a ponta com **uma única área de negócio** (escolha a que for prioridade, ex. `juridico`).
- Escrever o system prompt detalhado dessa área seguindo os critérios da seção 6.2 (checklist exaustivo, schema JSON rígido, anti-alucinação, referencial de compliance)
- Função no backend que monta a chamada à API do Claude (envio de PDF em base64 ou texto de CSV)
- Parsing e validação da resposta JSON retornada
- Testar manualmente com 2-3 documentos reais/fictícios conhecidos (golden set inicial)
**Critério de pronto:** ao chamar a função com um documento de teste, o retorno é um JSON válido, seguindo o schema definido, capturando corretamente os problemas conhecidos do documento de teste.
### Fase 5 — Pipeline Assíncrono e Persistência do Resultado
**Objetivo:** conectar upload → análise → resultado salvo, sem travar a requisição HTTP.
- Configurar fila/worker (ex.: BullMQ + Redis) ou processamento em background simples
- Fluxo: upload muda `status` para `processing` → worker chama Claude → salva em `analyses` → `status` vira `done` (ou `error`)
- Endpoint `GET /api/analyses/:id`
**Critério de pronto:** usuário sobe um documento, o status muda de `uploaded` → `processing` → `done` sem bloquear a resposta do upload, e o resultado final é consultável.
### Fase 6 — Frontend de Upload e Resultado
**Objetivo:** interface mínima para usar o fluxo completo.
- Tela de login/cadastro + aceite de termo
- Tela de upload (seleção de arquivo + `area_negocio`)
- Tela de status/polling (`processing`/`done`)
- Tela de resultado exibindo `resumo_executivo`, itens de compliance (`conforme`/`nao_conforme`/`nao_verificavel`) e `sugestoes_melhoria`
**Critério de pronto:** um usuário consegue, sem tocar em código, logar, aceitar o termo, subir um arquivo, escolher a área e ver o resultado formatado na tela.
### Fase 7 — Retenção de 72h
**Objetivo:** automatizar a exclusão do arquivo original.
- Job agendado (cron/worker) que varre `documents` com `expira_em` vencido
- Remoção do arquivo do Storage + atualização de `storage_path` (null) e `deletado_em`
- Endpoint de exclusão antecipada (usuário pode apagar antes das 72h)
**Critério de pronto:** um documento de teste com `expira_em` forçado para o passado é limpo automaticamente na próxima execução do job, sem afetar o registro de `analyses`.
### Fase 8 — Hardening de Segurança
**Objetivo:** fechar as lacunas de segurança antes de expor a aplicação publicamente.
- Rate limiting (login e upload)
- Logs de auditoria (login, upload, delete, falhas de auth)
- Revisão de headers HTTP (CSP, HSTS via Helmet)
- Scan antivírus no upload (se ainda não implementado na Fase 3)
- Revisão de RLS em todas as tabelas
**Critério de pronto:** checklist de segurança da seção 11 revisado item a item, com teste manual de cada ponto (ex.: tentar acessar documento de outro usuário, tentar estourar rate limit).
### Fase 9 — Expansão de Templates (demais áreas)
**Objetivo:** sair de 1 área piloto para todas as áreas planejadas (`financas`, `imobiliario`, `rh`, `saude`, `outro`).
- Escrever cada template seguindo o mesmo rigor da Fase 4
- Criar/expandir golden set de testes por área
- Versionamento dos templates (`prompt_templates`, se optar por tabela em vez de código)
**Critério de pronto:** cada área nova tem pelo menos 2-3 documentos de teste validando que o checklist específico daquele domínio é capturado corretamente.
### Fase 10 — Polimento e Deploy
**Objetivo:** produto pronto para uso real.
- Deploy do backend (ex.: Railway/Render/Fly.io) e frontend (Vercel)
- Monitoramento básico (logs de erro, alertas de falha na API do Claude)
- Revisão final do Termo de Uso/Política de Privacidade com o texto real
- Testes de carga leve no fluxo de upload + análise
**Critério de pronto:** aplicação acessível publicamente, com HTTPS, funcionando de ponta a ponta para um usuário externo de teste.
> **Dica prática:** trate cada fase como um "PR grande" — feche uma antes de abrir a próxima. As fases 0-6 formam o MVP funcional; 7-10 são obrigatórias antes de ir para produção real com dados de usuários reais.