import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { getAllowedOrigins } from './common/trusted-origin.guard';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  // M-5: 모든 출처 허용 대신 env CORS_ORIGINS(쉼표 구분, 기본 로컬 Vite 개발 서버)로 제한한다.
  const allowedOrigins = getAllowedOrigins();
  app.enableCors({ origin: allowedOrigins.includes('*') ? true : allowedOrigins });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  const port = Number(process.env.API_PORT ?? 3000);
  await app.listen(port);
  // NOTE: 트랜스크립트 원문/마스킹 텍스트는 로그에 남기지 않는다(NFR-1.2).
  // eslint-disable-next-line no-console
  console.log(`Auto QA API listening on port ${port}`);
}

bootstrap();
