import { Module } from '@nestjs/common';
import { EvalSheetsController } from './eval-sheets.controller';
import { EvalSheetsService } from './eval-sheets.service';

@Module({
  controllers: [EvalSheetsController],
  providers: [EvalSheetsService],
  exports: [EvalSheetsService],
})
export class EvalSheetsModule {}
