import { Module } from '@nestjs/common';
import { EvalSheetsService } from './eval-sheets.service';

@Module({
  providers: [EvalSheetsService],
  exports: [EvalSheetsService],
})
export class EvalSheetsModule {}
