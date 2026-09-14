/**
 * Fase 8 — heurística estática contra PDF malicioso.
 *
 * Não é um antivírus (não detecta assinaturas de malware conhecido) — é uma
 * checagem estrutural dos vetores de ataque mais comuns e bem documentados
 * em PDF: JavaScript embutido, ações de abrir/lançar outro programa, e
 * arquivos embutidos. Roda sempre, sem depender de nenhum serviço externo,
 * então cobre o caso mais comum (PDF com payload ativo) mesmo quando o
 * ClamAV (`MalwareScanService`) está desligado.
 *
 * Implementação: busca os operadores de dicionário do PDF (`/JavaScript`,
 * `/JS`, `/Launch`, `/OpenAction`, `/AA`, `/EmbeddedFile`) direto nos bytes
 * do arquivo. PDF é um formato baseado em texto/dicionários ASCII para esses
 * nomes de chave mesmo quando o conteúdo das streams está comprimido — o
 * `/Type` das ações e a declaração dos objetos não são comprimidos — por
 * isso a varredura em texto pega o caso comum sem precisar de um parser de
 * PDF completo. Isso é DELIBERADAMENTE conservador: pode ter falso positivo
 * (ex.: um formulário PDF legítimo com JavaScript de validação de campo),
 * mas para este produto (upload de contratos/documentos administrativos)
 * PDF com JS ativo não é um caso de uso esperado.
 */

interface Achado {
  padrao: string;
  motivo: string;
}

// Só tokens longos o bastante pra não colidir por acaso com bytes aleatórios
// de streams comprimidas (o miolo de um PDF é, na prática, dados binários
// pseudo-aleatórios). Tokens curtos como "/JS" ou "/AA" têm chance real de
// aparecer por coincidência num PDF grande (até 20MB, o limite do upload) e
// gerariam falso positivo — por isso ficam de fora, mesmo sendo indicadores
// legítimos; "/JavaScript" sozinho já cobre a esmagadora maioria dos casos
// reais de JS embutido (é o nome da entrada na árvore /Names e/ou do
// dicionário de ação), com risco de colisão desprezível dado o tamanho do token.
const PADROES_SUSPEITOS: Achado[] = [
  { padrao: '/JavaScript', motivo: 'PDF contém um dicionário /JavaScript (script embutido).' },
  { padrao: '/Launch', motivo: 'PDF contém uma ação /Launch (executar programa/arquivo externo).' },
  { padrao: '/OpenAction', motivo: 'PDF contém /OpenAction (executa algo automaticamente ao abrir).' },
  { padrao: '/EmbeddedFile', motivo: 'PDF contém um arquivo embutido (/EmbeddedFile).' },
  { padrao: '/RichMedia', motivo: 'PDF contém conteúdo RichMedia (Flash/mídia executável embutida).' },
];

export interface ResultadoHeuristicaPdf {
  suspeito: boolean;
  motivos: string[];
}

export function scanPdfHeuristics(buffer: Buffer): ResultadoHeuristicaPdf {
  // latin1 preserva 1 byte = 1 char, suficiente pra achar os tokens ASCII
  // do dicionário do PDF sem se preocupar com a codificação do restante.
  const texto = buffer.toString('latin1');

  const motivos = PADROES_SUSPEITOS.filter((p) => texto.includes(p.padrao)).map((p) => p.motivo);

  return { suspeito: motivos.length > 0, motivos };
}
