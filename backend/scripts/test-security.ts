/**
 * Critério de pronto da Fase 8: "checklist de segurança revisado item a
 * item, com teste manual de cada ponto (ex.: tentar acessar documento de
 * outro usuário, tentar estourar rate limit)".
 *
 * Este script sobe a aplicação real (HTTP, numa porta efêmera) e bate nela
 * como um cliente externo bateria — sem atalho por dentro dos services —
 * pra provar dois dos pontos mais importantes do checklist:
 *
 *   1. Isolamento entre usuários: o usuário B não consegue ver nem apagar
 *      um documento do usuário A (espera 404, não 200/403 — o
 *      DocumentsService nem revela que o documento existe).
 *   2. Rate limiting: martelar POST /api/auth/login com senha errada
 *      estoura o limite (5/min) e volta 429 antes de esgotar as tentativas.
 *
 * Rodar com: npm run security:test
 */
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'crypto';
import type { AddressInfo } from 'net';
import { AppModule } from '../src/app.module';
import { HttpExceptionFilter } from '../src/common/filters/http-exception.filter';
import { SupabaseService } from '../src/common/supabase/supabase.service';

async function main() {
  Logger.overrideLogger(['error']); // silencia o log de rota/instanceloader do Nest, só erros
  let ok = true;
  const check = (label: string, passou: boolean, detalhe?: string) => {
    console.log(`${passou ? '✅' : '❌'} ${label}${detalhe ? ` — ${detalhe}` : ''}`);
    ok &&= passou;
  };

  const app = await NestFactory.create(AppModule, { logger: ['error'] });
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionFilter());

  const server = await app.listen(0, '127.0.0.1');
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const config = app.get(ConfigService);
  const supabase = app.get(SupabaseService).getClient();
  const termsVersion = config.get<string>('terms.currentVersion')!;

  const criados: { userId: string; documentId?: string; storagePath?: string }[] = [];

  const registrar = async (email: string, password: string) => {
    const res = await fetch(`${base}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`Falha ao registrar ${email}: ${JSON.stringify(body)}`);
    criados.push({ userId: body.user.id });

    await fetch(`${base}/api/auth/accept-terms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${body.accessToken}` },
      body: JSON.stringify({ version: termsVersion }),
    });

    return { userId: body.user.id as string, accessToken: body.accessToken as string };
  };

  try {
    console.log(`App de teste no ar em ${base}\n`);

    const senha = 'SenhaForte#2026';
    const emailA = `security-test-a+${randomUUID()}@example.com`;
    const emailB = `security-test-b+${randomUUID()}@example.com`;

    const usuarioA = await registrar(emailA, senha);
    const usuarioB = await registrar(emailB, senha);
    check('Usuários A e B registrados e com termo aceito', true);

    // --- 1. Isolamento entre usuários ---------------------------------------
    const form = new FormData();
    form.append('area_negocio', 'juridico');
    form.append(
      'file',
      new Blob([Buffer.from('%PDF-1.4 conteúdo fictício de teste de segurança')], {
        type: 'application/pdf',
      }),
      'teste-seguranca.pdf',
    );

    const uploadRes = await fetch(`${base}/api/documents`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${usuarioA.accessToken}` },
      body: form,
    });
    const documento = await uploadRes.json();
    check('Usuário A consegue subir um documento', uploadRes.status === 201, `status ${uploadRes.status}`);
    criados[0].documentId = documento.id;
    criados[0].storagePath = documento.storage_path;

    const donoLendoProprio = await fetch(`${base}/api/documents/${documento.id}`, {
      headers: { Authorization: `Bearer ${usuarioA.accessToken}` },
    });
    check('Usuário A consegue ler o PRÓPRIO documento', donoLendoProprio.status === 200);

    const outroLendo = await fetch(`${base}/api/documents/${documento.id}`, {
      headers: { Authorization: `Bearer ${usuarioB.accessToken}` },
    });
    check(
      'Usuário B NÃO consegue ler o documento do usuário A (espera 404)',
      outroLendo.status === 404,
      `status ${outroLendo.status}`,
    );

    const outroApagando = await fetch(`${base}/api/documents/${documento.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${usuarioB.accessToken}` },
    });
    check(
      'Usuário B NÃO consegue apagar o documento do usuário A (espera 404)',
      outroApagando.status === 404,
      `status ${outroApagando.status}`,
    );

    const semToken = await fetch(`${base}/api/documents`);
    check('Sem token de acesso, a rota responde 401', semToken.status === 401, `status ${semToken.status}`);

    // --- 2. Rate limiting no login -------------------------------------------
    console.log('\nMartelando POST /api/auth/login com senha errada...');
    const statusCodes: number[] = [];
    for (let i = 0; i < 8; i++) {
      const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: emailA, password: 'senha-errada-de-proposito' }),
      });
      statusCodes.push(res.status);
    }
    console.log(`  status codes: [${statusCodes.join(', ')}]`);
    check(
      'Algumas tentativas passam (401 — senha errada) antes do limite',
      statusCodes.slice(0, 4).some((s) => s === 401),
    );
    check(
      'Rate limit estoura em algum momento (429) antes de esgotar as 8 tentativas',
      statusCodes.includes(429),
    );

    console.log(`\n${ok ? '✅ Todos os testes de segurança passaram.' : '❌ Algum teste falhou — ver acima.'}`);
    if (!ok) process.exitCode = 1;
  } finally {
    console.log('\nLimpando dados de teste...');
    for (const { userId, documentId, storagePath } of criados) {
      if (documentId) {
        await supabase.from('analyses').delete().eq('document_id', documentId);
        await supabase.from('documents').delete().eq('id', documentId);
      }
      if (storagePath) {
        const bucket = config.get<string>('supabase.storageBucket')!;
        await supabase.storage.from(bucket).remove([storagePath]);
      }
      await supabase.from('refresh_tokens').delete().eq('user_id', userId);
      await supabase.from('audit_logs').delete().eq('user_id', userId);
      await supabase.from('users').delete().eq('id', userId);
    }
    await app.close();
  }
}

main().catch((err) => {
  console.error('\nFalha ao rodar o teste de segurança:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
