import { Injectable } from '@nestjs/common';
import {
  LlmEvaluationProvider,
  LlmEvaluationRequest,
  LlmEvaluationResponse,
} from './llm-evaluation-provider.interface';

/**
 * Anthropic Claude 기반 실채점 프로바이더 — Phase 1은 인터페이스 자리만 확보한 스텁이다.
 *
 * 실제 구현 시(Phase 4 이후, ANTHROPIC_API_KEY 확보 시):
 *  - env `ANTHROPIC_MODEL`(기본 claude-sonnet-5)로 모델을 지정한다.
 *  - `./schema-builder.ts`의 buildEvaluationResponseJsonSchema(evalSheet)로 요청마다
 *    동적 구조화 출력 스키마를 생성해 tool_use/input_schema로 사용, item.score에
 *    maximum을 지정해 배점 초과를 API 레벨에서 차단한다(CLAUDE.md 핵심 설계 원칙).
 *  - RateLimit/APIConnection 오류는 Anthropic SDK의 기본 재시도(retries 옵션)에 맡긴다.
 *  - 마스킹된 트랜스크립트만 전송한다(원문 절대 미전송).
 */
@Injectable()
export class AnthropicLlmEvaluationProvider implements LlmEvaluationProvider {
  async evaluate(_request: LlmEvaluationRequest): Promise<LlmEvaluationResponse> {
    throw new Error(
      'AnthropicLlmEvaluationProvider는 아직 구현되지 않았습니다(Phase 1 범위 밖). ' +
        'LLM_PROVIDER=mock으로 설정해 사용하세요. (ANTHROPIC_API_KEY 확보 후 별도 Phase에서 구현 예정)',
    );
  }
}
