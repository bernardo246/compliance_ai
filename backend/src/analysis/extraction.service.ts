import { BadRequestException, Injectable } from '@nestjs/common';
import Papa from 'papaparse';
import { Workbook, type CellValue, type Buffer as ExcelBuffer } from 'exceljs';
import { extractText as extractPdfText, getDocumentProxy } from 'unpdf';
import { TipoDocumento } from '../documents/documents.types';

/**
 * Extrai o conteúdo de PDF/CSV/XLSX como texto estruturado para enviar ao
 * modelo de IA (seção 6, passo 5 da spec). Diferente da API do Claude — que
 * aceita PDF nativamente como bloco `document` em base64 — a OpenRouter
 * expõe uma API no formato chat-completions (estilo OpenAI), que não lê PDF
 * binário diretamente. Por isso extraímos o texto do PDF aqui também, e os
 * três tipos de arquivo compartilham o mesmo caminho a partir daqui: texto
 * puro enviado como mensagem de usuário para o modelo.
 */
@Injectable()
export class ExtractionService {
  async extractText(buffer: Buffer, tipo: TipoDocumento): Promise<string> {
    if (tipo === 'pdf') {
      return this.extractPdf(buffer);
    }
    if (tipo === 'csv') {
      return this.extractCsv(buffer);
    }
    if (tipo === 'xlsx') {
      return this.extractXlsx(buffer);
    }
    throw new BadRequestException(`Tipo de documento não suportado para extração: "${tipo}".`);
  }

  private async extractPdf(buffer: Buffer): Promise<string> {
    let text: string;
    try {
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const result = await extractPdfText(pdf, { mergePages: true });
      text = Array.isArray(result.text) ? result.text.join('\n') : result.text;
    } catch (err) {
      throw new BadRequestException(
        `Falha ao extrair texto do PDF: ${err instanceof Error ? err.message : 'arquivo inválido'}.`,
      );
    }

    if (!text || text.trim().length === 0) {
      throw new BadRequestException(
        'Não foi possível extrair texto do PDF (pode ser um PDF escaneado/imagem, sem camada de texto). OCR ainda não é suportado nesta fase.',
      );
    }

    return text;
  }

  private extractCsv(buffer: Buffer): string {
    const content = buffer.toString('utf-8');
    const parsed = Papa.parse<string[]>(content, { skipEmptyLines: true });

    if (parsed.errors.length > 0) {
      const firstError = parsed.errors[0];
      throw new BadRequestException(
        `Falha ao interpretar CSV: ${firstError.message} (linha ${firstError.row ?? '?'}).`,
      );
    }

    return this.rowsToText(parsed.data);
  }

  private async extractXlsx(buffer: Buffer): Promise<string> {
    const workbook = new Workbook();
    try {
      await workbook.xlsx.load(buffer as unknown as ExcelBuffer);
    } catch (err) {
      throw new BadRequestException(
        `Falha ao interpretar XLSX: ${err instanceof Error ? err.message : 'arquivo inválido'}.`,
      );
    }

    const sections: string[] = [];

    workbook.eachSheet((sheet) => {
      const rows: string[][] = [];
      sheet.eachRow((row) => {
        const values = (row.values as CellValue[]).slice(1); // índice 0 é sempre vazio no ExcelJS
        rows.push(values.map((cell) => this.cellToString(cell)));
      });

      if (rows.length > 0) {
        sections.push(`## Planilha: ${sheet.name}\n${this.rowsToText(rows)}`);
      }
    });

    if (sections.length === 0) {
      throw new BadRequestException('Arquivo XLSX não contém nenhuma planilha com dados.');
    }

    return sections.join('\n\n');
  }

  private cellToString(cell: CellValue): string {
    if (cell === null || cell === undefined) return '';
    if (typeof cell === 'object' && 'text' in cell) return String((cell as { text: unknown }).text);
    if (typeof cell === 'object' && 'result' in cell) return String((cell as { result: unknown }).result);
    if (cell instanceof Date) return cell.toISOString();
    return String(cell);
  }

  /**
   * Formata linhas como uma tabela em texto simples (delimitada por `|`),
   * legível tanto para humanos quanto para o modelo, e mais compacta que JSON
   * para o mesmo volume de dados (economiza tokens).
   */
  private rowsToText(rows: string[][]): string {
    if (rows.length === 0) return '(planilha vazia)';

    const [header, ...body] = rows;
    const lines = [
      header.join(' | '),
      header.map(() => '---').join(' | '),
      ...body.map((row) => row.join(' | ')),
    ];

    return lines.join('\n');
  }
}
