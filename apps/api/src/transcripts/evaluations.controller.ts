import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { EvaluationResultResponse } from '@auto-qa/shared-types';
import { OverrideItemScoreDto } from './dto/override-item-score.dto';
import { TranscriptsService } from './transcripts.service';

/** GET /evaluations/:id — /transcripts/:id 와 동일한 결과를 evaluationId 기준으로 조회 */
@Controller('evaluations')
export class EvaluationsController {
  constructor(private readonly transcriptsService: TranscriptsService) {}

  @Get(':id')
  async findOne(@Param('id') id: string): Promise<EvaluationResultResponse> {
    return this.transcriptsService.getResultByEvaluationId(id);
  }

  /** PATCH /evaluations/:id/items/:itemId — 점수 수동 보정(Override, FR-10, §4.5) */
  @Patch(':id/items/:itemId')
  async overrideItemScore(
    @Param('id') id: string,
    @Param('itemId') itemId: string,
    @Body() dto: OverrideItemScoreDto,
  ): Promise<EvaluationResultResponse> {
    return this.transcriptsService.overrideItemScore(id, itemId, dto);
  }
}
