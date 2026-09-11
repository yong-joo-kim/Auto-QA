import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { EvalSheetsModule } from './eval-sheets/eval-sheets.module';
import { EvaluationModule } from './evaluation/evaluation.module';
import { TranscriptsModule } from './transcripts/transcripts.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    EvalSheetsModule,
    EvaluationModule,
    TranscriptsModule,
  ],
})
export class AppModule {}
