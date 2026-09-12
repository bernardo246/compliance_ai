/**
 * Critério de pronto da Fase 7: "um documento de teste com `expira_em`
 * forçado para o passado é limpo automaticamente na próxima execução do
 * job, sem afetar o registro de `analyses`".
 *
 * Este script chama `RetentionService.purgeExpired()` de verdade (sem
 * esperar a hora do cron) contra dois documentos de teste:
 *
 *   - EXPIRADO: `expira_em` no passado → deve ser limpo (storage_path null,
 *     deletado_em preenchido, arquivo removido do Storage) e a `analyses`
 *     associada deve continuar intacta.
 *   - CONTROLE: `expira_em` no futuro → não deve ser tocado, prova que a
 *     varredura não é "limpa tudo".
 *
 * Rodar com: npm run retention:test
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '../src/app.module';
import { SupabaseService } from '../src/common/supabase/supabase.service';
import { RetentionService } from '../src/documents/retention.service';

async function main() {
  Logger.overrideLogger(['log', 'warn', 'error']);
  const app = await NestFactory.createApplicationContext(AppModule);

  const supabase = app.get(SupabaseService).getClient();
  const retention = app.get(RetentionService);
  const config = app.get(ConfigService);
  const bucket = config.get<string>('supabase.storageBucket')!;

  const fixture = Buffer.from('%PDF-1.4 conteúdo fictício para teste de retenção', 'utf-8');
  let userId: string | null = null;
  const criados: { id: string; storagePath: string }[] = [];

  const criarDocumento = async (expiraEmOffsetMs: number, label: string) => {
    const documentId = randomUUID();
    const storagePath = `${userId}/${documentId}-${label}.pdf`;

    const { error: upErr } = await supabase.storage
      .from(bucket)
      .upload(storagePath, fixture, { contentType: 'application/pdf', upsert: true });
    if (upErr) throw new Error(`Falha no upload (${label}): ${upErr.message}`);

    const { error: docErr } = await supabase.from('documents').insert({
      id: documentId,
      user_id: userId,
      tipo: 'pdf',
      area_negocio: 'juridico',
      nome_original: `${label}.pdf`,
      storage_path: storagePath,
      status: 'done',
      expira_em: new Date(Date.now() + expiraEmOffsetMs).toISOString(),
    });
    if (docErr) throw new Error(`Falha ao inserir documento (${label}): ${docErr.message}`);

    const { error: analiseErr } = await supabase.from('analyses').insert({
      document_id: documentId,
      resumo_executivo: `Análise fictícia (${label}) — usada só para provar que a retenção não mexe em analyses.`,
      status_compliance_geral: 'conforme',
      checklist: [],
      dados_faltantes: [],
      sugestoes_melhoria: [],
      aviso_legal: 'teste',
      modelo_usado: 'teste',
    });
    if (analiseErr) throw new Error(`Falha ao inserir análise (${label}): ${analiseErr.message}`);

    criados.push({ id: documentId, storagePath });
    return documentId;
  };

  try {
    const email = `retention-test+${randomUUID()}@example.com`;
    const { data: user, error: userError } = await supabase
      .from('users')
      .insert({ email, password_hash: 'x', terms_accepted: true, terms_version: '1.0.0' })
      .select('id')
      .single();
    if (userError) throw new Error(`Falha ao criar usuário de teste: ${userError.message}`);
    userId = user.id;

    console.log('Criando documento EXPIRADO (expira_em no passado)...');
    const expiradoId = await criarDocumento(-60 * 60 * 1000, 'expirado');

    console.log('Criando documento CONTROLE (expira_em no futuro)...');
    const controleId = await criarDocumento(60 * 60 * 1000, 'controle');

    console.log('\nRodando RetentionService.purgeExpired()...\n');
    const resultado = await retention.purgeExpired();
    console.log(`Resultado da varredura: ${JSON.stringify(resultado)}`);

    let ok = true;

    // --- Verifica o documento EXPIRADO -------------------------------------
    const { data: expirado } = await supabase
      .from('documents')
      .select('storage_path, deletado_em')
      .eq('id', expiradoId)
      .single();

    const expiradoLimpo = expirado?.storage_path === null && !!expirado?.deletado_em;
    console.log(
      `\n[EXPIRADO] storage_path=${expirado?.storage_path ?? 'null'} deletado_em=${expirado?.deletado_em ?? 'null'} → ${
        expiradoLimpo ? '✅ limpo como esperado' : '❌ deveria ter sido limpo'
      }`,
    );
    ok &&= expiradoLimpo;

    const { data: arquivoRemovido, error: downloadErr } = await supabase.storage
      .from(bucket)
      .download(`${userId}/${expiradoId}-expirado.pdf`);
    const arquivoRealmenteRemovido = !arquivoRemovido && !!downloadErr;
    console.log(
      `[EXPIRADO] arquivo no Storage → ${arquivoRealmenteRemovido ? '✅ removido' : '❌ ainda existe'}`,
    );
    ok &&= arquivoRealmenteRemovido;

    const { data: analiseExpirado } = await supabase
      .from('analyses')
      .select('resumo_executivo')
      .eq('document_id', expiradoId)
      .maybeSingle();
    const analiseIntacta = !!analiseExpirado;
    console.log(
      `[EXPIRADO] registro em analyses → ${analiseIntacta ? '✅ intacto (não foi tocado)' : '❌ desapareceu'}`,
    );
    ok &&= analiseIntacta;

    // --- Verifica o documento CONTROLE -------------------------------------
    const { data: controle } = await supabase
      .from('documents')
      .select('storage_path, deletado_em')
      .eq('id', controleId)
      .single();

    const controleIntacto = controle?.storage_path !== null && !controle?.deletado_em;
    console.log(
      `\n[CONTROLE] storage_path=${controle?.storage_path} deletado_em=${controle?.deletado_em ?? 'null'} → ${
        controleIntacto ? '✅ não foi tocado (correto)' : '❌ foi limpo indevidamente'
      }`,
    );
    ok &&= controleIntacto;

    console.log(
      `\n${ok ? '✅ Critério de pronto da Fase 7 atendido.' : '❌ Alguma verificação falhou — ver acima.'}`,
    );
    if (!ok) process.exitCode = 1;
  } finally {
    console.log('\nLimpando dados de teste...');
    for (const { id, storagePath } of criados) {
      await supabase.from('analyses').delete().eq('document_id', id);
      await supabase.from('documents').delete().eq('id', id);
      await supabase.storage.from(bucket).remove([storagePath]); // no-op se já removido
    }
    if (userId) {
      await supabase.from('audit_logs').delete().eq('user_id', userId);
      await supabase.from('users').delete().eq('id', userId);
    }
    await app.close();
  }
}

main().catch((err) => {
  console.error('\nFalha no teste de retenção:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
