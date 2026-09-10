/**
 * Critério de pronto da Fase 5: "usuário sobe um documento, o status muda de
 * uploaded → processing → done sem bloquear a resposta do upload, e o
 * resultado final é consultável".
 *
 * Este script exercita o pipeline assíncrono de verdade (Storage + banco +
 * AnalysisRunnerService + OpenRouter), sem passar pelo HTTP/autenticação:
 *
 *   1. sobe um PDF do golden set para o Supabase Storage
 *   2. insere uma linha em `documents` com status 'uploaded'
 *   3. chama `AnalysisRunnerService.enqueue()` (fire-and-forget, igual ao upload)
 *   4. faz polling em `documents.status` até 'done' / 'error'
 *   5. imprime a linha de `analyses` resultante
 *   6. limpa tudo que criou (analyses, documents, objeto no Storage)
 *
 * Pré-requisitos:
 *   - `npm run golden:build` já rodado (gera os PDFs em test-fixtures/)
 *   - migração 002 aplicada no Supabase
 *   - .env com SUPABASE_* e OPENROUTER_* preenchidos
 *
 * Rodar com: npm run pipeline:test
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '../src/app.module';
import { SupabaseService } from '../src/common/supabase/supabase.service';
import { AnalysisRunnerService } from '../src/analysis/analysis-runner.service';

const FIXTURE = join(__dirname, '..', 'test-fixtures', 'juridico-contrato-com-problemas.pdf');
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 6 * 60 * 1000;

async function main() {
  Logger.overrideLogger(['log', 'warn', 'error']);
  const app = await NestFactory.createApplicationContext(AppModule, { bufferLogs: false });

  const supabase = app.get(SupabaseService).getClient();
  const runner = app.get(AnalysisRunnerService);
  const config = app.get(ConfigService);
  const bucket = config.get<string>('supabase.storageBucket')!;

  const fixture = await readFile(FIXTURE);
  const documentId = randomUUID();
  let userId: string | null = null;
  let storagePath: string | null = null;

  try {
    // --- usuário de teste (a FK documents.user_id -> users.id exige um) ------
    const email = `pipeline-test+${documentId}@example.com`;
    const { data: user, error: userError } = await supabase
      .from('users')
      .insert({ email, password_hash: 'x', terms_accepted: true, terms_version: '1.0.0' })
      .select('id')
      .single();
    if (userError) throw new Error(`Falha ao criar usuário de teste: ${userError.message}`);
    userId = user.id;

    // --- 1. upload para o Storage ------------------------------------------
    storagePath = `${userId}/${documentId}-contrato.pdf`;
    const { error: upErr } = await supabase.storage
      .from(bucket)
      .upload(storagePath, fixture, { contentType: 'application/pdf', upsert: true });
    if (upErr) throw new Error(`Falha no upload para o Storage: ${upErr.message}`);

    // --- 2. linha em documents (status 'uploaded') -------------------------
    const expiraEm = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();
    const { error: docErr } = await supabase.from('documents').insert({
      id: documentId,
      user_id: userId,
      tipo: 'pdf',
      area_negocio: 'juridico',
      nome_original: 'contrato.pdf',
      storage_path: storagePath,
      status: 'uploaded',
      expira_em: expiraEm,
    });
    if (docErr) throw new Error(`Falha ao inserir documento: ${docErr.message}`);

    // --- 3. enfileira (exatamente o que o upload HTTP faz) ----------------
    const enqueuedAt = Date.now();
    runner.enqueue(documentId);
    console.log(`\nDocumento ${documentId} enfileirado. Aguardando o pipeline...\n`);

    // --- 4. polling do status -------------------------------------------------
    const seen: string[] = [];
    let finalStatus = 'uploaded';
    let erro: string | null = null;

    while (Date.now() - enqueuedAt < POLL_TIMEOUT_MS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const { data } = await supabase
        .from('documents')
        .select('status, erro')
        .eq('id', documentId)
        .single();

      const status = data?.status ?? 'uploaded';
      if (status !== seen[seen.length - 1]) {
        seen.push(status);
        console.log(`  [${((Date.now() - enqueuedAt) / 1000).toFixed(0)}s] status: ${status}`);
      }
      if (status === 'done' || status === 'error') {
        finalStatus = status;
        erro = data?.erro ?? null;
        break;
      }
    }

    console.log(`\nTransições observadas: ${seen.join(' → ') || '(nenhuma)'}`);

    // --- 5. resultado ------------------------------------------------------
    if (finalStatus === 'done') {
      const { data: analise } = await supabase
        .from('analyses')
        .select('*')
        .eq('document_id', documentId)
        .single();

      console.log('\n===== ANÁLISE PERSISTIDA (analyses) =====');
      console.log(`status_compliance_geral: ${analise?.status_compliance_geral}`);
      console.log(`modelo_usado: ${analise?.modelo_usado}`);
      console.log(`tokens_usados: ${analise?.tokens_usados ?? '(não reportado)'}`);
      console.log(`template_versao: ${analise?.template_versao}`);
      console.log(`checklist: ${(analise?.checklist ?? []).length} itens`);
      console.log(`sugestoes_melhoria: ${(analise?.sugestoes_melhoria ?? []).length}`);
      console.log(`\nresumo_executivo:\n${analise?.resumo_executivo}`);

      const criterio =
        seen.includes('processing') && seen.includes('done')
          ? '✅ Critério de pronto da Fase 5 atendido (uploaded → processing → done, resultado consultável).'
          : '⚠️  Terminou em "done" mas não observei a transição por "processing" — o polling pode ter sido lento demais.';
      console.log(`\n${criterio}`);
    } else if (finalStatus === 'error') {
      console.log(`\n❌ A análise terminou em 'error': ${erro}`);
      process.exitCode = 1;
    } else {
      console.log(`\n❌ Timeout: o status não chegou a 'done'/'error' em ${POLL_TIMEOUT_MS / 1000}s.`);
      process.exitCode = 1;
    }
  } finally {
    // --- 6. limpeza ------------------------------------------------------------
    console.log('\nLimpando dados de teste...');
    await supabase.from('analyses').delete().eq('document_id', documentId);
    await supabase.from('documents').delete().eq('id', documentId);
    if (storagePath) await supabase.storage.from(bucket).remove([storagePath]);
    if (userId) {
      await supabase.from('audit_logs').delete().eq('user_id', userId);
      await supabase.from('users').delete().eq('id', userId);
    }
    await app.close();
  }
}

main().catch((err) => {
  console.error('\nFalha no teste de pipeline:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
