import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableCors();
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
