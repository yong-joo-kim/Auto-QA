import { Module } from '@nestjs/common';
import { EvalSheetsModule } from '../eval-sheets/eval-sheets.module';
import { EvaluationModule } from '../evaluation/evaluation.module';
import { TranscriptsController } from './transcripts.controller';
import { EvaluationsController } from './evaluations.controller';
import { TranscriptsService } from './transcripts.service';

@Module({
  imports: [EvalSheetsModule, EvaluationModule],
  controllers: [TranscriptsController, EvaluationsController],
  providers: [TranscriptsService],
})
export class TranscriptsModule {}
