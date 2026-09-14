/**
 * Gera os documentos do "golden set" — fictícios com problemas conhecidos
 * injetados de propósito, para validar se cada template de área realmente
 * captura o que deveria capturar (seção 6.2, último critério: "testes com
 * casos conhecidos" antes de confiar no template).
 *
 * Fase 4 gerou só o par `juridico`. Fase 9 generaliza para as 6 áreas —
 * cada uma com um par (`-com-problemas.pdf` / `-bem-estruturado.pdf`),
 * mantendo os nomes de arquivo do `juridico` inalterados (outros scripts
 * dependem deles: `test-pipeline.ts`, `test-retention.ts`).
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

interface Fixture {
  arquivo: string;
  titulo: string;
  paragrafos: string[];
}

// ---------------------------------------------------------------------------
// juridico (Fase 4) — nomes de arquivo mantidos, usados por outros scripts.
// ---------------------------------------------------------------------------
const JURIDICO_COM_PROBLEMAS: Fixture = {
  arquivo: 'juridico-contrato-com-problemas.pdf',
  titulo: 'CONTRATO DE PRESTAÇÃO DE SERVIÇOS',
  paragrafos: [
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
  ],
};

const JURIDICO_BEM_ESTRUTURADO: Fixture = {
  arquivo: 'juridico-contrato-bem-estruturado.pdf',
  titulo: 'CONTRATO DE PRESTAÇÃO DE SERVIÇOS',
  paragrafos: [
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
  ],
};

// ---------------------------------------------------------------------------
// financas (Fase 9)
// ---------------------------------------------------------------------------
const FINANCAS_COM_PROBLEMAS: Fixture = {
  arquivo: 'financas-com-problemas.pdf',
  titulo: 'RELATÓRIO DE FLUXO DE CAIXA — JANEIRO/2026',
  paragrafos: [
    'Empresa: Comércio Delta Ltda. Período de referência: 01/01/2026 a 31/01/2026.',
    'Saldo inicial do período: R$ 45.000,00 (o relatório de dezembro/2025 registrou saldo final de R$ 42.000,00).',
    // Problema 1: saldo inicial não bate com o saldo final do período anterior.
    '05/01/2026 - Pagamento fornecedor ABC Ltda - R$ 3.200,00 (Categoria: Fornecedores).',
    '05/01/2026 - Pagamento fornecedor ABC Ltda - R$ 3.200,00 (Categoria: Fornecedores).',
    // Problema 2: lançamento duplicado (mesma data, valor e descrição).
    '32/01/2026 - Recebimento cliente XPTO - R$ 6.500,00 (Categoria: Vendas).',
    // Problema 3: data impossível (32/01) — fora de sequência/inválida.
    '18/01/2026 - Compra de material de escritório - R$ 850,00 (Categoria: Material de Escritório).',
    '22/01/2026 - Compra de suprimentos administrativos - R$ 620,00 (Categoria: Despesas Administrativas).',
    // Problema 4: mesma natureza de despesa (material/suprimentos de escritório) categorizada de duas formas diferentes.
    '25/01/2026 - Pagamento consultoria especializada - R$ 15.000,00 (Categoria: Serviços Profissionais).',
    // Problema 5: despesa relevante (R$ 15.000,00) sem referência a nota fiscal ou comprovante.
    'Receita total do mês: R$ 95.000,00 (receita de dezembro/2025 foi de R$ 20.000,00).',
    // Problema 6: variação abrupta (375%) entre períodos sem nenhuma nota explicativa.
    'Saldo final do período: R$ 58.850,00.',
  ],
};

const FINANCAS_BEM_ESTRUTURADO: Fixture = {
  arquivo: 'financas-bem-estruturado.pdf',
  titulo: 'RELATÓRIO DE FLUXO DE CAIXA — JANEIRO/2026',
  paragrafos: [
    'Empresa: Comércio Épsilon Ltda. Período de referência: 01/01/2026 a 31/01/2026.',
    'Saldo inicial do período: R$ 42.000,00 (idêntico ao saldo final de dezembro/2025, conforme relatório anterior).',
    '05/01/2026 - Pagamento fornecedor ABC Ltda - R$ 3.200,00 (Categoria: Fornecedores) - NF nº 4521.',
    '12/01/2026 - Recebimento cliente XPTO - R$ 6.500,00 (Categoria: Vendas) - NF nº 998.',
    '18/01/2026 - Compra de material de escritório - R$ 850,00 (Categoria: Material de Escritório) - NF nº 102.',
    '25/01/2026 - Pagamento consultoria especializada - R$ 15.000,00 (Categoria: Serviços Profissionais) - NF nº 3310.',
    'Receita total do mês: R$ 24.000,00 (variação de +9% em relação a dezembro/2025, dentro do padrão sazonal do negócio).',
    'Saldo final do período: R$ 47.450,00.',
    'Alçada de aprovação: pagamentos acima de R$ 10.000,00 exigem dupla assinatura (diretor financeiro e sócio-administrador), conforme política interna vigente.',
  ],
};

// ---------------------------------------------------------------------------
// imobiliario (Fase 9)
// ---------------------------------------------------------------------------
const IMOBILIARIO_COM_PROBLEMAS: Fixture = {
  arquivo: 'imobiliario-com-problemas.pdf',
  titulo: 'CONTRATO DE COMPRA E VENDA DE IMÓVEL',
  paragrafos: [
    'VENDEDOR: João Pereira. COMPRADOR: Ana Costa, CPF 111.222.333-44.',
    'OBJETO: Compra e venda do imóvel situado na Rua das Palmeiras, nº 45, São Paulo/SP, com área construída de 120m².',
    // Problema 1: sem número de matrícula do imóvel.
    'Consta ainda que o imóvel possui, segundo medição recente, 145m² de área total.',
    // Problema 2: metragem divergente entre dois trechos do mesmo documento (120m² vs 145m²).
    'CLÁUSULA PRIMEIRA - DO PREÇO: O valor da transação é de R$ 450.000,00 (quatrocentos e cinquenta mil reais), a ser pago em parcela única no ato da assinatura.',
    'CLÁUSULA SEGUNDA - DA ENTREGA: O imóvel será entregue livre e desocupado em até 30 (trinta) dias após a assinatura.',
    // Problema 3: nenhuma menção a ônus/gravames (ausência total, não presumir "sem ônus").
    // Problema 4: nenhuma referência a certidão negativa de débitos (IPTU/condomínio).
    'CLÁUSULA TERCEIRA - DO FORO: Fica eleito o foro da comarca de São Paulo/SP.',
    'E por estarem justas e contratadas, assinam o presente instrumento.',
    'VENDEDOR: José Pereira - COMPRADOR: Ana Costa.',
    // Problema 5: nome do vendedor diverge entre a qualificação inicial (João Pereira) e a assinatura (José Pereira).
  ],
};

const IMOBILIARIO_BEM_ESTRUTURADO: Fixture = {
  arquivo: 'imobiliario-bem-estruturado.pdf',
  titulo: 'CONTRATO DE COMPRA E VENDA DE IMÓVEL',
  paragrafos: [
    'VENDEDOR: Carlos Mendes, CPF 222.333.444-55. COMPRADOR: Beatriz Lima, CPF 555.666.777-88.',
    'OBJETO: Compra e venda do imóvel situado na Rua das Palmeiras, nº 45, São Paulo/SP, registrado sob a matrícula nº 78.542 no 5º Cartório de Registro de Imóveis de São Paulo/SP, com área construída de 120m², conforme consta na matrícula.',
    'Consta da matrícula nº 78.542 que o imóvel está livre e desembaraçado de quaisquer ônus, gravames, hipotecas ou penhoras, e que a construção existente encontra-se devidamente averbada.',
    'CLÁUSULA PRIMEIRA - DO PREÇO: O valor da transação é de R$ 450.000,00 (quatrocentos e cinquenta mil reais), a ser pago em parcela única no ato da assinatura.',
    'CLÁUSULA SEGUNDA - DA ENTREGA: O imóvel será entregue livre e desocupado em até 30 (trinta) dias após a assinatura, mediante apresentação de certidão negativa de débitos de IPTU e de quitação condominial.',
    'CLÁUSULA TERCEIRA - DO FORO: Fica eleito o foro da comarca de São Paulo/SP.',
    'São Paulo, 10 de janeiro de 2026.',
    'E por estarem justas e contratadas, assinam o presente instrumento.',
    'VENDEDOR: Carlos Mendes - COMPRADOR: Beatriz Lima.',
  ],
};

// ---------------------------------------------------------------------------
// rh (Fase 9)
// ---------------------------------------------------------------------------
const RH_COM_PROBLEMAS: Fixture = {
  arquivo: 'rh-com-problemas.pdf',
  titulo: 'CONTRATO INDIVIDUAL DE TRABALHO',
  paragrafos: [
    'EMPREGADOR: Comércio Gama Ltda, CNPJ 11.222.333/0001-44. EMPREGADO: Pedro Alves, CPF 999.888.777-66.',
    'CARGO: Analista Administrativo. DATA DE ADMISSÃO: 01/02/2026.',
    // Problema 1: sem referência a CTPS/eSocial.
    'JORNADA DE TRABALHO: 60 (sessenta) horas semanais, de segunda a sábado.',
    // Problema 2: jornada acima do limite legal (44h/semana), sem menção a regime especial.
    'SALÁRIO: R$ 2.200,00 (dois mil e duzentos reais) mensais.',
    'CLÁUSULA PRIMEIRA - DO PERÍODO DE EXPERIÊNCIA: O contrato terá período de experiência de 180 (cento e oitenta) dias.',
    // Problema 3: período de experiência acima do limite legal (máx. 90 dias, art. 445 CLT).
    'CLÁUSULA SEGUNDA: O EMPREGADO renuncia expressamente ao pagamento de horas extras eventualmente prestadas além da jornada contratual.',
    // Problema 4: cláusula de renúncia a direito trabalhista indisponível (horas extras) — sempre nula.
    // Problema 5 (implícito): sem menção a férias nem a 13º salário.
    'CLÁUSULA TERCEIRA - DA RESCISÃO: O contrato poderá ser rescindido por qualquer das partes mediante aviso prévio de 30 dias.',
    'E por estarem de acordo, as partes assinam o presente instrumento.',
    'EMPREGADOR: ___________________  EMPREGADO: ___________________',
  ],
};

const RH_BEM_ESTRUTURADO: Fixture = {
  arquivo: 'rh-bem-estruturado.pdf',
  titulo: 'CONTRATO INDIVIDUAL DE TRABALHO',
  paragrafos: [
    'EMPREGADOR: Comércio Ômega Ltda, CNPJ 22.333.444/0001-55. EMPREGADO: Fernanda Dias, CPF 888.777.666-55, CTPS nº 1234567, série 0045-SP.',
    'CARGO: Analista Administrativo, categoria enquadrada na Convenção Coletiva de Trabalho do Sindicato dos Empregados no Comércio de São Paulo. DATA DE ADMISSÃO: 01/02/2026, com registro em eSocial na data de admissão.',
    'JORNADA DE TRABALHO: 44 (quarenta e quatro) horas semanais, de segunda a sexta-feira, das 08h às 17h, com 1 hora de intervalo intrajornada.',
    'SALÁRIO: R$ 3.200,00 (três mil e duzentos reais) mensais, compatível com o piso salarial da categoria previsto na convenção coletiva vigente.',
    'CLÁUSULA PRIMEIRA - DO PERÍODO DE EXPERIÊNCIA: O contrato terá período de experiência de 45 (quarenta e cinco) dias, prorrogável por igual período, totalizando no máximo 90 (noventa) dias, nos termos do art. 445 da CLT.',
    'CLÁUSULA SEGUNDA - DOS BENEFÍCIOS: O EMPREGADO fará jus a férias de 30 dias após 12 meses de vigência do contrato, 13º salário, vale-transporte e vale-refeição, nos termos da legislação vigente.',
    'CLÁUSULA TERCEIRA - DA RESCISÃO: O contrato poderá ser rescindido por qualquer das partes mediante aviso prévio de 30 dias, observadas as verbas rescisórias devidas em cada modalidade de desligamento.',
    'São Paulo, 20 de janeiro de 2026.',
    'EMPREGADOR: ___________________  EMPREGADO: ___________________',
  ],
};

// ---------------------------------------------------------------------------
// saude (Fase 9) — completude administrativa, nunca clínica.
// ---------------------------------------------------------------------------
const SAUDE_COM_PROBLEMAS: Fixture = {
  arquivo: 'saude-com-problemas.pdf',
  titulo: 'RELATÓRIO DE ATENDIMENTO AMBULATORIAL',
  paragrafos: [
    'PACIENTE: Marcos Silva.',
    // Problema 1: sem CPF do paciente.
    // Problema 2: sem data de nascimento do paciente.
    'DATA DO ATENDIMENTO: 14/01/2026.',
    'PROFISSIONAL RESPONSÁVEL: Dra. Camila Torres.',
    // Problema 3: sem número de registro profissional (CRM).
    'ESTABELECIMENTO: Clínica São Lucas, CNPJ 33.444.555/0001-66.',
    'CID: ___________________________',
    // Problema 4: campo de CID/diagnóstico presente no formulário mas deixado em branco.
    'PROCEDIMENTO REALIZADO: pequena cirurgia ambulatorial para remoção de lesão de pele.',
    // Problema 5 (implícito): procedimento invasivo mencionado, mas sem nenhuma referência a termo de consentimento informado.
    'CONDUTA: encaminhamento para acompanhamento em 15 dias.',
    'Documento emitido para fins administrativos.',
    // Problema 6: sem assinatura/carimbo do profissional responsável.
  ],
};

const SAUDE_BEM_ESTRUTURADO: Fixture = {
  arquivo: 'saude-bem-estruturado.pdf',
  titulo: 'RELATÓRIO DE ATENDIMENTO AMBULATORIAL',
  paragrafos: [
    'PACIENTE: Juliana Ramos, CPF 444.555.666-77, data de nascimento 03/04/1990.',
    'DATA DO ATENDIMENTO: 14/01/2026.',
    'PROFISSIONAL RESPONSÁVEL: Dr. Ricardo Nunes, CRM/SP 123456.',
    'ESTABELECIMENTO: Clínica Santa Helena, CNPJ 44.555.666/0001-77.',
    'CID: L72.0 (cisto epidérmico).',
    'PROCEDIMENTO REALIZADO: pequena cirurgia ambulatorial para remoção de cisto de pele, com termo de consentimento informado assinado pela paciente em 14/01/2026 (anexo a este documento).',
    'CONDUTA: encaminhamento para acompanhamento em 15 dias, com retorno agendado.',
    'Documento emitido para fins administrativos, assinado eletronicamente pelo profissional responsável.',
    'Assinatura e carimbo: Dr. Ricardo Nunes - CRM/SP 123456.',
  ],
};

// ---------------------------------------------------------------------------
// outro (Fase 9) — checklist genérico de boas práticas documentais.
// ---------------------------------------------------------------------------
const OUTRO_COM_PROBLEMAS: Fixture = {
  arquivo: 'outro-com-problemas.pdf',
  titulo: 'POLÍTICA INTERNA DE HOME OFFICE',
  paragrafos: [
    'Esta política estabelece as diretrizes para trabalho remoto na empresa.',
    // Problema 1: sem data de emissão.
    // Problema 2: sem identificação do responsável/área emissora.
    // Problema 3: sem versão/revisão do documento.
    '1. Elegibilidade: podem solicitar home office os colaboradores conforme critérios definidos no Anexo II.',
    // Problema 4: referência a "Anexo II" que não está presente no material.
    '2. Equipamentos: a empresa fornecerá os equipamentos necessários listados na seção correspondente.',
    '3. Horário: o colaborador deve manter disponibilidade dentro do horário comercial padrão.',
    // Problema 5: sem data de vigência/validade da política.
    '4. Revisão: esta política poderá ser revista a qualquer momento pela diretoria.',
  ],
};

const OUTRO_BEM_ESTRUTURADO: Fixture = {
  arquivo: 'outro-bem-estruturado.pdf',
  titulo: 'POLÍTICA INTERNA DE HOME OFFICE',
  paragrafos: [
    'Documento: Política Interna de Home Office. Versão 2.1. Emitido por: Diretoria de Gente e Gestão.',
    'Data de emissão: 05/01/2026. Vigência: 05/01/2026 a 05/01/2027, sujeita a revisão anual.',
    '1. Elegibilidade: podem solicitar home office os colaboradores que atendam aos critérios descritos na seção 1.1 deste documento (mínimo de 6 meses de empresa e função compatível com trabalho remoto).',
    '2. Equipamentos: a empresa fornecerá notebook e cadeira ergonômica, conforme especificado na seção 2 deste documento.',
    '3. Horário: o colaborador deve manter disponibilidade das 9h às 18h, com 1 hora de intervalo.',
    '4. Revisão: esta política será revisada anualmente pela Diretoria de Gente e Gestão, com nova versão publicada e comunicada a todos os colaboradores.',
    'Aprovado por: Diretoria de Gente e Gestão, em 05/01/2026.',
  ],
};

const TODAS_AS_FIXTURES: Fixture[] = [
  JURIDICO_COM_PROBLEMAS,
  JURIDICO_BEM_ESTRUTURADO,
  FINANCAS_COM_PROBLEMAS,
  FINANCAS_BEM_ESTRUTURADO,
  IMOBILIARIO_COM_PROBLEMAS,
  IMOBILIARIO_BEM_ESTRUTURADO,
  RH_COM_PROBLEMAS,
  RH_BEM_ESTRUTURADO,
  SAUDE_COM_PROBLEMAS,
  SAUDE_BEM_ESTRUTURADO,
  OUTRO_COM_PROBLEMAS,
  OUTRO_BEM_ESTRUTURADO,
];

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });

  // eslint-disable-next-line no-console
  console.log(`Golden set gerado em ${OUTPUT_DIR}:\n`);

  for (const fixture of TODAS_AS_FIXTURES) {
    const pdf = await makePdf(fixture.titulo, fixture.paragrafos);
    await writeFile(join(OUTPUT_DIR, fixture.arquivo), pdf);
    // eslint-disable-next-line no-console
    console.log(`  - ${fixture.arquivo}`);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
