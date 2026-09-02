import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { SupabaseService } from '../common/supabase/supabase.service';
import { AreaNegocio } from './dto/upload-document.dto';
import { MIME_TO_TIPO } from './documents.types';

const SEVENTY_TWO_HOURS_MS = 72 * 60 * 60 * 1000;

@Injectable()
export class DocumentsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly config: ConfigService,
  ) {}

  private db() {
    return this.supabase.getClient();
  }

  /**
   * Valida o MIME type real do arquivo lendo os magic bytes (não confia na
   * extensão nem no Content-Type declarado pelo cliente) e o tamanho máximo.
   */
  private async validateFile(file: Express.Multer.File) {
    const maxSizeBytes = this.config.get<number>('upload.maxSizeMb')! * 1024 * 1024;
    if (file.size > maxSizeBytes) {
      throw new BadRequestException(
        `Arquivo excede o tamanho máximo permitido (${this.config.get('upload.maxSizeMb')}MB).`,
      );
    }

    // CSV puro não tem magic bytes reconhecíveis por file-type; nesse caso
    // caímos de volta para o mimetype declarado, mas só quando o conteúdo
    // é texto puro plausível (checagem simples de bytes não-binários).
    // `file-type` é ESM-only; como o backend compila para CommonJS,
    // usamos dynamic import() em vez de um `import` estático (que quebraria
    // em runtime com ERR_REQUIRE_ESM apesar de compilar sem erro no tsc).
    // `file-type` é ESM-only; usamos dynamic import() (necessário em runtime,
    // já que o backend compila para CommonJS) e tipamos como `unknown`/cast
    // manual, pois o `moduleResolution` do projeto (node/commonjs) não
    // resolve o mapa de `exports` condicional do pacote em tempo de build.
    type FileTypeModule = { fileTypeFromBuffer: (buf: Buffer) => Promise<{ mime: string } | undefined> };
    const { fileTypeFromBuffer } = (await import('file-type')) as unknown as FileTypeModule;
    const detected = await fileTypeFromBuffer(file.buffer);
    const allowed: string[] = this.config.get('upload.allowedMimeTypes')!;

    const isCsvFallback =
      !detected &&
      file.mimetype === 'text/csv' &&
      this.looksLikeText(file.buffer);

    const realMime = detected?.mime ?? (isCsvFallback ? 'text/csv' : undefined);

    if (!realMime || !allowed.includes(realMime)) {
      throw new BadRequestException(
        'Tipo de arquivo não permitido. Envie PDF, CSV ou XLSX.',
      );
    }

    // TODO (Fase 8 — hardening): rodar scan antivírus (ex. ClamAV) aqui
    // antes de liberar o arquivo para upload no Storage.

    return realMime;
  }

  private looksLikeText(buffer: Buffer): boolean {
    const sample = buffer.subarray(0, 1024);
    let nonPrintable = 0;
    for (const byte of sample) {
      if (byte === 0) return false;
      if (byte < 7 || (byte > 14 && byte < 32)) nonPrintable++;
    }
    return nonPrintable / sample.length < 0.05;
  }

  async upload(
    userId: string,
    areaNegocio: AreaNegocio,
    file: Express.Multer.File,
  ) {
    const realMime = await this.validateFile(file);
    const tipo = MIME_TO_TIPO[realMime];
    const documentId = randomUUID();
    const bucket = this.config.get<string>('supabase.storageBucket')!;
    const storagePath = `${userId}/${documentId}-${file.originalname}`;

    const { error: uploadError } = await this.db()
      .storage.from(bucket)
      .upload(storagePath, file.buffer, {
        contentType: realMime,
        upsert: false,
      });

    if (uploadError) {
      throw new BadRequestException(`Falha ao enviar arquivo: ${uploadError.message}`);
    }

    const now = new Date();
    const expiraEm = new Date(now.getTime() + SEVENTY_TWO_HOURS_MS);

    const { data: document, error: insertError } = await this.db()
      .from('documents')
      .insert({
        id: documentId,
        user_id: userId,
        tipo,
        area_negocio: areaNegocio,
        nome_original: file.originalname,
        storage_path: storagePath,
        status: 'uploaded',
        expira_em: expiraEm.toISOString(),
      })
      .select('*')
      .single();

    if (insertError) {
      // Rollback best-effort do arquivo já enviado, para não deixar órfão no bucket.
      await this.db().storage.from(bucket).remove([storagePath]);
      throw new BadRequestException(`Falha ao registrar documento: ${insertError.message}`);
    }

    await this.logAudit(userId, 'upload');
    return document;
  }

  async listForUser(userId: string) {
    const { data, error } = await this.db()
      .from('documents')
      .select('id, tipo, area_negocio, nome_original, status, expira_em, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new BadRequestException(`Falha ao listar documentos: ${error.message}`);
    }
    return data;
  }

  async findOneForUser(userId: string, documentId: string) {
    const { data, error } = await this.db()
      .from('documents')
      .select('*')
      .eq('id', documentId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error || !data) {
      throw new NotFoundException('Documento não encontrado.');
    }
    return data;
  }

  async deleteForUser(userId: string, documentId: string) {
    const document = await this.findOneForUser(userId, documentId);
    const bucket = this.config.get<string>('supabase.storageBucket')!;

    if (document.storage_path) {
      await this.db().storage.from(bucket).remove([document.storage_path]);
    }

    const { error } = await this.db()
      .from('documents')
      .update({ storage_path: null, deletado_em: new Date().toISOString() })
      .eq('id', documentId);

    if (error) {
      throw new BadRequestException(`Falha ao excluir documento: ${error.message}`);
    }

    await this.logAudit(userId, 'delete_document');
    return { success: true };
  }

  private async logAudit(userId: string, acao: string) {
    await this.db()
      .from('audit_logs')
      .insert({ id: randomUUID(), user_id: userId, acao, ip_address: null });
  }
}
