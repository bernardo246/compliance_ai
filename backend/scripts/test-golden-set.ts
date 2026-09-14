/**
 * Critério de pronto da Fase 4 (e da Fase 9, estendido às 6 áreas): "ao
 * chamar a função com um documento de teste, o retorno é um JSON válido,
 * seguindo o schema definido, capturando corretamente os problemas
 * conhecidos do documento de teste."
 *
 * Roda a AnalysisService de verdade (contra a API configurada em
 * OPENROUTER_API_KEY) para os pares de fixtures de cada área, e confere se
 * os problemas conhecidos injetados em `build-golden-set.ts` aparecem no
 * checklist retornado.
 *
 * Rodar com:
 *   npm run golden:test                # todas as 6 áreas (sequencial)
 *   npm run golden:test -- juridico     # só uma área específica
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
import { AreaNegocio } from '../src/documents/dto/upload-document.dto';

const FIXTURES_DIR = join(__dirname, '..', 'test-fixtures');

interface GoldenSetConfig {
  area: AreaNegocio;
  comProblemas: string;
  bemEstruturado: string;
  // Trechos esperados no checklist do documento "com problemas" — correspondência
  // parcial (case-insensitive) no nome do item + evidência, já que o modelo
  // pode variar levemente a redação exata.
  problemasEsperados: string[];
}

const GOLDEN_SETS: GoldenSetConfig[] = [
  {
    area: 'juridico',
    comProblemas: 'juridico-contrato-com-problemas.pdf',
    bemEstruturado: 'juridico-contrato-bem-estruturado.pdf',
    problemasEsperados: ['CPF', 'reajuste', 'multa', 'confidencialidade', 'assinatura', 'testemunha'],
  },
  {
    area: 'financas',
    comProblemas: 'financas-com-problemas.pdf',
    bemEstruturado: 'financas-bem-estruturado.pdf',
    problemasEsperados: ['saldo', 'duplicad', 'cronológ', 'categoriz', 'comprovante', 'variação'],
  },
  {
    area: 'imobiliario',
    comProblemas: 'imobiliario-com-problemas.pdf',
    bemEstruturado: 'imobiliario-bem-estruturado.pdf',
    problemasEsperados: ['matrícula', 'metragem', 'ônus', 'certidão', 'proprietário'],
  },
  {
    area: 'rh',
    comProblemas: 'rh-com-problemas.pdf',
    bemEstruturado: 'rh-bem-estruturado.pdf',
    problemasEsperados: ['ctps', 'jornada', 'experiência', 'renúncia', 'férias'],
  },
  {
    area: 'saude',
    comProblemas: 'saude-com-problemas.pdf',
    bemEstruturado: 'saude-bem-estruturado.pdf',
    problemasEsperados: ['cpf', 'nascimento', 'crm', 'diagnóstico', 'assinatura', 'consentimento'],
  },
  {
    area: 'outro',
    comProblemas: 'outro-com-problemas.pdf',
    bemEstruturado: 'outro-bem-estruturado.pdf',
    problemasEsperados: ['emissão', 'responsável', 'versão', 'anexo', 'vigência'],
  },
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

function checkGoldenSet(
  result: AnalysisResult,
  problemasEsperados: string[],
): { encontrados: string[]; faltando: string[] } {
  const itensNaoConformes = result.checklist
    .filter((i) => i.status_compliance !== 'conforme')
    .map((i) => `${i.item} ${i.evidencia ?? ''}`.toLowerCase());

  const encontrados: string[] = [];
  const faltando: string[] = [];

  for (const termo of problemasEsperados) {
    const achou = itensNaoConformes.some((texto) => texto.includes(termo.toLowerCase()));
    (achou ? encontrados : faltando).push(termo);
  }

  return { encontrados, faltando };
}

async function runArea(analysisService: AnalysisService, config: GoldenSetConfig) {
  console.log(`\n\n${'#'.repeat(70)}`);
  console.log(`# ÁREA: ${config.area}`);
  console.log('#'.repeat(70));

  const comProblemasBuffer = await readFile(join(FIXTURES_DIR, config.comProblemas));
  const bemEstruturadoBuffer = await readFile(join(FIXTURES_DIR, config.bemEstruturado));

  console.log(`\nAnalisando ${config.comProblemas} (com problemas conhecidos)...`);
  const comProblemas = await analysisService.analyze(comProblemasBuffer, 'pdf', config.area);
  printResult(config.comProblemas, comProblemas.result);

  console.log(`\n\nAnalisando ${config.bemEstruturado} (bem estruturado)...`);
  const bemEstruturado = await analysisService.analyze(bemEstruturadoBuffer, 'pdf', config.area);
  printResult(config.bemEstruturado, bemEstruturado.result);

  const { encontrados, faltando } = checkGoldenSet(comProblemas.result, config.problemasEsperados);

  console.log(`\n${'='.repeat(70)}`);
  console.log(`CONFERÊNCIA DO GOLDEN SET — ${config.area}`);
  console.log('='.repeat(70));
  console.log(
    `Problemas capturados (${encontrados.length}/${config.problemasEsperados.length}): ${
      encontrados.join(', ') || '(nenhum)'
    }`,
  );
  if (faltando.length > 0) {
    console.log(`⚠️  Problemas NÃO capturados: ${faltando.join(', ')}`);
    console.log('   (isso não necessariamente indica erro — confira manualmente o checklist acima;');
    console.log('    pode ser variação de redação do modelo. Mas se cair repetidamente, revise o prompt.)');
  } else {
    console.log('✅ Todos os problemas conhecidos foram capturados pelo checklist.');
  }

  return { area: config.area, capturados: encontrados.length, total: config.problemasEsperados.length };
}

async function main() {
  const config = buildConfigService();
  const analysisService = new AnalysisService(new ExtractionService(), new OpenRouterClient(config));

  const filtro = process.argv[2] as AreaNegocio | undefined;
  const alvo = filtro ? GOLDEN_SETS.filter((g) => g.area === filtro) : GOLDEN_SETS;

  if (filtro && alvo.length === 0) {
    console.error(
      `Área "${filtro}" desconhecida. Áreas disponíveis: ${GOLDEN_SETS.map((g) => g.area).join(', ')}`,
    );
    process.exit(1);
  }

  const resumo: { area: AreaNegocio; capturados: number; total: number }[] = [];
  for (const conf of alvo) {
    resumo.push(await runArea(analysisService, conf));
  }

  console.log(`\n\n${'='.repeat(70)}`);
  console.log('RESUMO GERAL');
  console.log('='.repeat(70));
  for (const r of resumo) {
    const ok = r.capturados === r.total;
    console.log(`${ok ? '✅' : '⚠️ '} ${r.area}: ${r.capturados}/${r.total} problemas conhecidos capturados`);
  }
}

main().catch((err) => {
  console.error('\nFalha ao rodar o golden set:', err instanceof Error ? err.message : err);
  if (err?.rawResponse) {
    console.error('\nResposta bruta recebida da IA:\n', err.rawResponse);
  }
  process.exit(1);
});
