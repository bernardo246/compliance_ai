/**
 * Gera os documentos do "golden set" da Fase 4 — contratos fictícios com
 * problemas conhecidos injetados de propósito, para validar se o template
 * `juridico` realmente captura o que deveria capturar (seção 6.2, último
 * critério: "testes com casos conhecidos" antes de confiar no template).
 *
 * Rodar com: npm run golden:build
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

const OUTPUT_DIR = join(__dirname, '..', 'test-fixtures');

async function makePdf(title: string, paragraphs: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage([595, 842]); // A4
  const margin = 50;
  const maxWidth = page.getWidth() - margin * 2;
  let y = page.getHeight() - margin;

  const drawWrapped = (text: string, useFont = font, size = 11, lineGap = 5) => {
    const words = text.split(' ');
    let line = '';
    for (const word of words) {
      const testLine = line ? `${line} ${word}` : word;
      if (useFont.widthOfTextAtSize(testLine, size) > maxWidth) {
        if (y < margin + size) {
          page = doc.addPage([595, 842]);
          y = page.getHeight() - margin;
        }
        page.drawText(line, { x: margin, y, size, font: useFont, color: rgb(0, 0, 0) });
        y -= size + lineGap;
        line = word;
      } else {
        line = testLine;
      }
    }
    if (line) {
      if (y < margin + size) {
        page = doc.addPage([595, 842]);
        y = page.getHeight() - margin;
      }
      page.drawText(line, { x: margin, y, size, font: useFont, color: rgb(0, 0, 0) });
      y -= size + lineGap;
    }
  };

  drawWrapped(title, bold, 16, 10);
  y -= 10;
  for (const paragraph of paragraphs) {
    drawWrapped(paragraph);
    y -= 8;
  }

  return doc.save();
}

async function buildContratoComProblemas() {
  return makePdf('CONTRATO DE PRESTAÇÃO DE SERVIÇOS', [
    'CONTRATANTE: Empresa Alfa Comércio de Equipamentos Ltda, inscrita no CNPJ sob nº 12.345.678/0001-90.',
    'CONTRATADA: João da Silva Prestação de Serviços.',
    // Propositalmente SEM CPF do contratado — problema conhecido nº 1 (qualificação incompleta).
    'OBJETO: A CONTRATADA prestará serviços de consultoria em tecnologia da informação para a CONTRATANTE.',
    'CLÁUSULA PRIMEIRA - DO PRAZO: O presente contrato vigorará por 12 (doze) meses a partir da assinatura, renovando-se automaticamente por períodos iguais e sucessivos, salvo manifestação em contrário de qualquer das partes.',
    // Renovação automática presente, mas sem prazo mínimo de aviso para não renovar — problema conhecido nº 2.
    'CLÁUSULA SEGUNDA - DO VALOR: A CONTRATANTE pagará à CONTRATADA o valor mensal de R$ 8.000,00 (oito mil reais), reajustado anualmente.',
    // Reajuste mencionado mas SEM índice definido — problema conhecido nº 3.
    'CLÁUSULA TERCEIRA - DA MULTA: Em caso de rescisão antecipada por parte da CONTRATADA, esta pagará multa de 50% (cinquenta por cento) do valor total do contrato. Em caso de rescisão por parte da CONTRATANTE, não haverá multa.',
    // Multa desproporcional entre as partes — problema conhecido nº 4 (cláusula potencialmente leonina).
    'CLÁUSULA QUARTA - DA CONFIDENCIALIDADE: As partes se comprometem a manter sigilo sobre informações trocadas durante a vigência deste contrato.',
    // Confidencialidade sem prazo de duração pós-contrato nem penalidade por quebra — problema conhecido nº 5.
    'CLÁUSULA QUINTA - DO FORO: Fica eleito o foro da comarca de São Paulo/SP para dirimir quaisquer controvérsias oriundas deste contrato.',
    'E por estarem assim justas e contratadas, firmam o presente instrumento.',
    // SEM campo de assinatura das partes nem testemunhas — problema conhecido nº 6.
    // SEM data e local de celebração — problema conhecido nº 7.
  ]);
}

async function buildContratoBemEstruturado() {
  return makePdf('CONTRATO DE PRESTAÇÃO DE SERVIÇOS', [
    'CONTRATANTE: Empresa Beta Consultoria Ltda, CNPJ 98.765.432/0001-10, com sede na Av. Paulista, 1000, São Paulo/SP.',
    'CONTRATADA: Maria Souza, CPF 123.456.789-00, residente na Rua das Flores, 200, São Paulo/SP.',
    'OBJETO: A CONTRATADA prestará serviços de consultoria contábil para a CONTRATANTE, conforme escopo detalhado no Anexo I.',
    'CLÁUSULA PRIMEIRA - DO PRAZO: O contrato vigorará de 01/01/2026 a 31/12/2026, podendo ser renovado mediante termo aditivo assinado por ambas as partes com no mínimo 30 (trinta) dias de antecedência ao término da vigência.',
    'CLÁUSULA SEGUNDA - DO VALOR E REAJUSTE: O valor mensal é de R$ 5.000,00 (cinco mil reais), reajustado anualmente pelo IPCA acumulado no período.',
    'CLÁUSULA TERCEIRA - DA RESCISÃO: Qualquer das partes poderá rescindir o contrato mediante aviso prévio de 30 (trinta) dias. Em caso de rescisão imotivada antes do prazo, a parte responsável pagará multa equivalente a 20% (vinte por cento) do saldo remanescente do contrato, aplicável a ambas as partes igualmente.',
    'CLÁUSULA QUARTA - DA CONFIDENCIALIDADE: As partes obrigam-se a manter sigilo sobre todas as informações trocadas, durante a vigência do contrato e por 24 (vinte e quatro) meses após seu término, sob pena de multa de R$ 10.000,00 (dez mil reais) por violação comprovada.',
    'CLÁUSULA QUINTA - DO FORO: Fica eleito o foro da comarca de São Paulo/SP, com renúncia expressa a qualquer outro, por mais privilegiado que seja.',
    'E por estarem justas e contratadas, as partes assinam o presente instrumento em 2 (duas) vias de igual teor, na presença de 2 (duas) testemunhas.',
    'São Paulo, 15 de dezembro de 2025.',
    'CONTRATANTE: ___________________  CONTRATADA: ___________________',
    'TESTEMUNHA 1: __________________  TESTEMUNHA 2: __________________',
  ]);
}

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const comProblemas = await buildContratoComProblemas();
  await writeFile(join(OUTPUT_DIR, 'juridico-contrato-com-problemas.pdf'), comProblemas);

  const bemEstruturado = await buildContratoBemEstruturado();
  await writeFile(join(OUTPUT_DIR, 'juridico-contrato-bem-estruturado.pdf'), bemEstruturado);

  // eslint-disable-next-line no-console
  console.log(`Golden set gerado em ${OUTPUT_DIR}:`);
  // eslint-disable-next-line no-console
  console.log('  - juridico-contrato-com-problemas.pdf (7 problemas conhecidos injetados)');
  // eslint-disable-next-line no-console
  console.log('  - juridico-contrato-bem-estruturado.pdf (contrato bem formado, poucos apontamentos esperados)');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
