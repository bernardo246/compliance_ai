import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  // Fase 8 — só habilita se TRUST_PROXY=true (backend atrás de um reverse
  // proxy conhecido). Sem isso, `req.ip` (usado pelo rate limit e pelos
  // logs de auditoria) refletiria o IP do proxy, não o do cliente real —
  // mas confiar em X-Forwarded-For sem ter certeza de que existe um proxy
  // seria pior (permite falsificar o IP só com um header).
  if (config.get<boolean>('trustProxy')) {
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
  }

  app.use(
    helmet({
      // API pura em JSON — não serve HTML/CSS/JS próprio. CSP restritiva por
      // padrão é defesa em profundidade (ex.: se uma resposta de erro algum
      // dia acabar sendo renderizada por engano num browser).
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      hsts: {
        maxAge: 15552000, // 180 dias
        includeSubDomains: true,
      },
      crossOriginResourcePolicy: { policy: 'same-origin' },
    }),
  );
  app.use(cookieParser());

  app.enableCors({
    origin: config.get<string>('frontendUrl'),
    credentials: true, // necessário para o cookie httpOnly do refresh token
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new HttpExceptionFilter());

  const port = config.get<number>('port') ?? 3001;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`Backend rodando em http://localhost:${port}`);
}

bootstrap();
