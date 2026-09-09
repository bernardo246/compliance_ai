/**
 * Critério de pronto da Fase 4: "ao chamar a função com um documento de
 * teste, o retorno é um JSON válido, seguindo o schema definido, capturando
 * corretamente os problemas conhecidos do documento de teste."
 *
 * Este script chama a AnalysisService de verdade (contra a API configurada
 * em OPENROUTER_API_KEY) para os dois documentos do golden set, e confere
 * se os problemas conhecidos injetados em `build-golden-set.ts` realmente
 * aparecem no checklist retornado.
 *
 * Rodar com: npm run golden:test
 * (requer ter rodado `npm run golden:build` antes, e ter OPENROUTER_API_KEY
 * configurada no .env)
 */
import 'dotenv/config';
import { ConfigService } from '@nestjs/config';
import { readFile } from 'fs/promises';
import { join } from 'path';
import configuration from '../src/config/configuration';
import { AnalysisService } from '../src/analysis/analysis.service';
import { ExtractionService } from '../src/analysis/extraction.service';
import { OpenRouterClient } from '../src/analysis/openrouter.client';
import { AnalysisResult } from '../src/analysis/schemas/analysis-result.schema';

const FIXTURES_DIR = join(__dirname, '..', 'test-fixtures');

// Trechos de item esperados no checklist do contrato "com problemas" —
// usamos correspondência parcial (case-insensitive) no nome do item, já que
// o modelo pode variar levemente a redação exata.
const PROBLEMAS_ESPERADOS = [
  'CPF',
  'reajuste',
  'multa',
  'confidencialidade',
  'assinatura',
  'testemunha',
];

function buildConfigService(): ConfigService {
  const raw = configuration();
  return new ConfigService(raw);
}

function printResult(label: string, result: AnalysisResult) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`RESULTADO — ${label}`);
  console.log('='.repeat(70));
  console.log(`status_compliance_geral: ${result.status_compliance_geral}`);
  console.log(`\nresumo_executivo:\n${result.resumo_executivo}`);
  console.log(`\nchecklist (${result.checklist.length} itens):`);
  for (const item of result.checklist) {
    console.log(
      `  [${item.status_compliance.padEnd(15)}] (${item.severidade.padEnd(8)}) ${item.item}`,
    );
    if (item.status_compliance !== 'conforme') {
      console.log(`      evidência: ${item.evidencia ?? '(nenhuma)'}`);
      console.log(`      sugestão: ${item.sugestao_correcao ?? '(nenhuma)'}`);
    }
  }
  console.log(`\ndados_faltantes: ${JSON.stringify(result.dados_faltantes)}`);
  console.log(`\nsugestoes_melhoria (${result.sugestoes_melhoria.length}):`);
  result.sugestoes_melhoria.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
}

function checkGoldenSet(result: AnalysisResult): { encontrados: string[]; faltando: string[] } {
  const itensNaoConformes = result.checklist
    .filter((i) => i.status_compliance !== 'conforme')
    .map((i) => `${i.item} ${i.evidencia ?? ''}`.toLowerCase());

  const encontrados: string[] = [];
  const faltando: string[] = [];

  for (const termo of PROBLEMAS_ESPERADOS) {
    const achou = itensNaoConformes.some((texto) => texto.includes(termo.toLowerCase()));
    (achou ? encontrados : faltando).push(termo);
  }

  return { encontrados, faltando };
}

async function main() {
  const config = buildConfigService();
  const analysisService = new AnalysisService(new ExtractionService(), new OpenRouterClient(config));

  const comProblemasBuffer = await readFile(
    join(FIXTURES_DIR, 'juridico-contrato-com-problemas.pdf'),
  );
  const bemEstruturadoBuffer = await readFile(
    join(FIXTURES_DIR, 'juridico-contrato-bem-estruturado.pdf'),
  );

  console.log('Analisando contrato COM problemas conhecidos...');
  const resultadoComProblemas = await analysisService.analyze(comProblemasBuffer, 'pdf', 'juridico');
  printResult('contrato-com-problemas.pdf', resultadoComProblemas);

  console.log('\n\nAnalisando contrato bem estruturado...');
  const resultadoBemEstruturado = await analysisService.analyze(
    bemEstruturadoBuffer,
    'pdf',
    'juridico',
  );
  printResult('contrato-bem-estruturado.pdf', resultadoBemEstruturado);

  const { encontrados, faltando } = checkGoldenSet(resultadoComProblemas);

  console.log(`\n${'='.repeat(70)}`);
  console.log('CONFERÊNCIA DO GOLDEN SET (contrato com problemas)');
  console.log('='.repeat(70));
  console.log(`Problemas capturados (${encontrados.length}/${PROBLEMAS_ESPERADOS.length}): ${encontrados.join(', ') || '(nenhum)'}`);
  if (faltando.length > 0) {
    console.log(`⚠️  Problemas NÃO capturados: ${faltando.join(', ')}`);
    console.log('   (isso não necessariamente indica erro — confira manualmente o checklist acima;');
    console.log('    pode ser variação de redação do modelo. Mas se cair repetidamente, revise o prompt.)');
  } else {
    console.log('✅ Todos os problemas conhecidos foram capturados pelo checklist.');
  }
}

main().catch((err) => {
  console.error('\nFalha ao rodar o golden set:', err instanceof Error ? err.message : err);
  if (err?.rawResponse) {
    console.error('\nResposta bruta recebida da IA:\n', err.rawResponse);
  }
  process.exit(1);
});
