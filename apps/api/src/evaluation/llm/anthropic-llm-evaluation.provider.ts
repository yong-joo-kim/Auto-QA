import { Injectable } from '@nestjs/common';
import {
  LlmEvaluationProvider,
  LlmEvaluationRequest,
  LlmEvaluationResponse,
} from './llm-evaluation-provider.interface';

/**
 * Anthropic Claude 기반 실채점 프로바이더 — 아직 인터페이스 자리만 확보한 스텁이다.
 *
 * `GeminiLlmEvaluationProvider`(최초 실 프로바이더 구현, `docs/decisions/ADR-001-gemini-llm-provider.md`)가
 * 세운 패턴을 재사용한다. 실제 구현 시(ANTHROPIC_API_KEY 확보 후):
 *  - env `ANTHROPIC_MODEL`(기본 claude-sonnet-5)로 모델을 지정한다.
 *  - 타임아웃/재시도/백오프는 `./http-retry.ts`의 fetchWithRetry를 재사용한다(복붙 금지).
 *  - 구조화 출력 스키마는 `./schema-builder.ts`의 buildEvaluationResponseJsonSchema(evalSheet)를
 *    우선 시도하되, Anthropic tool `input_schema`가 `const`/`anyOf`/`additionalProperties`를
 *    실제로 지원하는지 실호출로 먼저 검증한다(추측 금지 — Gemini는 이 세 요소를 모두
 *    거부했다. `./llm/README.md` 참고).
 *  - `profanityCheck`/`piiCheck`는 Gemini와 동일하게 로컬 `detectProfanity()`/`detectPii()`로
 *    산출하는 방안을 우선 검토한다(Phase 3 골든 코퍼스 결정론성 유지).
 *  - 마스킹된 트랜스크립트만 전송한다(원문 절대 미전송).
 *  - 자세한 공통 규약은 `./llm/README.md` 참고.
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
