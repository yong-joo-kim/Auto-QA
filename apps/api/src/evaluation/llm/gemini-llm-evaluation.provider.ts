import { Injectable } from '@nestjs/common';
import {
  LlmEvaluationProvider,
  LlmEvaluationRequest,
  LlmEvaluationResponse,
} from './llm-evaluation-provider.interface';

/**
 * Google Gemini 기반 실채점 프로바이더 — Phase 1은 인터페이스 자리만 확보한 스텁이다.
 * Google AI Studio 키 확보 시 별도 Phase에서 구현 예정. AnthropicLlmEvaluationProvider와
 * 동일하게 `./schema-builder.ts`의 동적 구조화 출력 스키마를 재사용한다.
 */
@Injectable()
export class GeminiLlmEvaluationProvider implements LlmEvaluationProvider {
  async evaluate(_request: LlmEvaluationRequest): Promise<LlmEvaluationResponse> {
    throw new Error(
      'GeminiLlmEvaluationProvider는 아직 구현되지 않았습니다(Phase 1 범위 밖). ' +
        'LLM_PROVIDER=mock으로 설정해 사용하세요. (Google AI Studio 키 확보 후 구현 예정)',
    );
  }
}
