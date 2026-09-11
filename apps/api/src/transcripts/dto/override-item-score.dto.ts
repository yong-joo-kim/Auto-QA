import { IsInt, IsOptional, IsString, Min } from 'class-validator';
import { OverrideItemScoreRequest } from '@auto-qa/shared-types';

/**
 * PATCH /evaluations/:id/items/:itemId 요청 바디 (FR-10, §4.5).
 * 상한(item.maxScore)은 항목마다 다르므로 여기서는 하한(0)/정수만 검증하고,
 * 상한 검증은 서비스 계층(`TranscriptsService.overrideItemScore`)에서 수행한다.
 */
export class OverrideItemScoreDto implements OverrideItemScoreRequest {
  @IsInt()
  @Min(0)
  score!: number;

  @IsOptional()
  @IsString()
  note?: string;

  @IsOptional()
  @IsString()
  reviewer?: string;
}
