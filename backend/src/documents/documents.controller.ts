import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Ip,
  Param,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser, AuthenticatedUser } from '../common/decorators/current-user.decorator';
import { TermsAcceptedGuard } from '../common/guards/terms-accepted.guard';
import { DocumentsService } from './documents.service';
import { UploadDocumentDto } from './dto/upload-document.dto';

@Controller('api/documents')
@UseGuards(TermsAcceptedGuard) // Fase 2: sem termo aceito, nenhuma rota daqui funciona
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Post()
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 20 * 1024 * 1024 }, // hard cap; validação fina fica no service
    }),
  )
  // Fase 8 — cada upload aciona Storage + (depois) a IA; limite mais apertado
  // que o default de 60/min da rota (ver ThrottlerModule em app.module.ts).
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async upload(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadDocumentDto,
    @Ip() ip: string,
  ) {
    if (!file) {
      throw new BadRequestException('Nenhum arquivo enviado (campo "file").');
    }
    return this.documentsService.upload(user.id, dto.area_negocio, file, ip);
  }

  @Get()
  async list(@CurrentUser() user: AuthenticatedUser) {
    return this.documentsService.listForUser(user.id);
  }

  @Get(':id')
  async findOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.documentsService.findOneForUser(user.id, id);
  }

  @Delete(':id')
  async remove(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Ip() ip: string) {
    return this.documentsService.deleteForUser(user.id, id, ip);
  }
}
