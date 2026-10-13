/**
 * Teste AO VIVO (Supabase real, sem Docker nem Redis) da retenção de audit_logs e de raw_response:
 * grava linhas com `created_at` controlado, roda o RetentionService de verdade e confere o resultado.
 * Cria um usuário de teste e apaga tudo no fim.
 *   npx ts-node scripts/test-data-retention-live.ts
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { Logger } from '@nestjs/common';
import { RetentionService } from '../src/documents/retention.service';

Logger.overrideLogger(false);
const diasAtras = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const resultados: boolean[] = [];
const check = (nome: string, ok: boolean, extra = '') => {
  resultados.push(ok);
  console.log(`${ok ? '✅' : '❌'} ${nome}${extra ? ' — ' + extra : ''}`);
};

async function main() {
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const cfg: Record<string, any> = { 'dataRetention.auditLogDays': 90, 'dataRetention.rawResponseDays': 30 };
  const retention = new RetentionService({ getClient: () => db } as any, { get: (k: string) => cfg[k] } as any, {} as any);
  let userId: string | null = null;
  const marca = `retlive-${Date.now()}`;

  try {
    const { data: u, error: ue } = await db.from('users')
      .insert({ email: `${marca}@example.com`, password_hash: 'x', terms_accepted: true, terms_version: '1.1.0' })
      .select('id').single();
    if (ue) throw new Error(ue.message);
    userId = u.id;

    // audit_logs: 3 antigos (100, 95, 91 dias), 2 recentes (89 e 1 dia). Sem user_id para não depender do FK.
    const audit = [100, 95, 91, 89, 1].map((d) => ({ id: randomUUID(), user_id: userId, acao: `teste_${marca}_${d}d`, ip_address: '203.0.113.9', created_at: diasAtras(d) }));
    const { error: ae } = await db.from('audit_logs').insert(audit);
    if (ae) throw new Error('insert audit_logs: ' + ae.message);

    // documentos + análises: 40 e 31 dias (devem zerar raw_response), 29 e 5 dias (devem manter), 60 dias já sem raw
    const mkDoc = (d: number) => ({ id: randomUUID(), user_id: userId, tipo: 'pdf', area_negocio: 'juridico', nome_original: `${marca}-${d}d.pdf`, status: 'done', expira_em: diasAtras(-3), deletado_em: diasAtras(1) });
    const docs = [40, 31, 29, 5, 60].map(mkDoc);
    const { error: de } = await db.from('documents').insert(docs);
    if (de) throw new Error('insert documents: ' + de.message);
    const analises = docs.map((doc, i) => {
      const d = [40, 31, 29, 5, 60][i];
      return { id: randomUUID(), document_id: doc.id, resumo_executivo: `resumo ${d}d`, raw_response: d === 60 ? null : { texto: 'resposta bruta da IA '.repeat(20) }, created_at: diasAtras(d) };
    });
    const { error: ane } = await db.from('analyses').insert(analises);
    if (ane) throw new Error('insert analyses: ' + ane.message);

    // ---- roda a retenção de verdade ----
    const apagados = await retention.purgeOldAuditLogs();
    const zerados = await retention.purgeOldRawResponses();
    // o banco real tem outras linhas (do uso normal); o teste mede só as dele
    console.log(`   retorno: audit_logs apagados=${apagados} (inclui qualquer outro registro >90 dias), raw_response zeradas=${zerados}`);

    const { data: audRestantes } = await db.from('audit_logs').select('acao').like('acao', `teste_${marca}%`);
    const restam = (audRestantes ?? []).map((r) => r.acao.split('_').pop()).sort().join(',');
    check('audit_logs: os de 100, 95 e 91 dias foram apagados; os de 89 e 1 dia ficaram', restam === '1d,89d', `restam=${restam}`);

    const { data: an } = await db.from('analyses').select('resumo_executivo, raw_response').in('document_id', docs.map((d) => d.id));
    const por = Object.fromEntries((an ?? []).map((r) => [r.resumo_executivo, r.raw_response]));
    check('analyses: as de 40 e 31 dias tiveram raw_response zerado', por['resumo 40d'] === null && por['resumo 31d'] === null);
    check('analyses: as de 29 e 5 dias mantiveram a resposta bruta', por['resumo 29d'] !== null && por['resumo 5d'] !== null);
    check('analyses: nenhuma análise foi apagada e o resumo continua em todas', (an ?? []).length === 5 && Object.keys(por).length === 5);

    const { data: an2 } = await db.from('analyses').select('raw_response').in('document_id', docs.map((d) => d.id)).not('raw_response', 'is', null).lt('created_at', diasAtras(30));
    check('nenhuma análise do teste com mais de 30 dias ainda tem raw_response', (an2 ?? []).length === 0);
  } finally {
    if (userId) {
      await db.from('audit_logs').delete().like('acao', `teste_${marca}%`);
      await db.from('documents').delete().eq('user_id', userId); // análises saem em cascata
      await db.from('users').delete().eq('id', userId);
      console.log('limpeza feita (usuário, documentos, análises e registros de teste).');
    }
  }
  const ok = resultados.length > 0 && resultados.every(Boolean);
  console.log(ok ? `\n✅ ${resultados.length} de ${resultados.length} verificações passaram.` : `\n❌ ${resultados.filter((r) => !r).length} verificação(ões) falharam.`);
  process.exitCode = ok ? 0 : 1;
}
main().catch((e) => { console.error('FALHA:', e); process.exit(1); });
