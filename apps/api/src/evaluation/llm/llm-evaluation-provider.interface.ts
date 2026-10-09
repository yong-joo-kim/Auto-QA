import { EvalSheet } from '@auto-qa/eval-schema';

/**
 * LLM Provider 추상화 계약.
 * 참고: docs/requirements/phase1-vertical-slice.md §4.2, CLAUDE.md §컨벤션
 *
 * mock / anthropic / gemini 세 구현체가 모두 동일한 요청/응답 타입을 사용해야 하며,
 * 호출부(EvaluationService)는 어떤 구현체가 주입되었는지 몰라도 동작해야 한다
 * (env `LLM_PROVIDER` 값만으로 전환 가능, 코드 변경 불필요 — NFR-2.2/2.3).
 */

export interface LlmEvaluationRequest {
  domainId: string;
  /** PII 마스킹이 완료된 텍스트만 전달된다. 원문은 이 인터페이스에 절대 노출되지 않는다. */
  maskedTranscript: string;
  /** 매칭된 도메인 평가시트 1개 전체 (전체 10종을 매번 전송하지 않는다) */
  evalSheet: EvalSheet;
}

export type PassFail = 'P' | 'F';
export type Speaker = 'customer' | 'agent';

export interface LlmItemResult {
  itemId: string;
  score: number;
  reason: string;
  /** gating: false 항목은 없어야 하며, gating: true 항목은 필수 */
  passFail?: PassFail;
}

export interface LlmProviderMeta {
  provider: string;
  model: string;
  latencyMs: number;
}

export interface LlmCoaching {
  /** 1~3개 */
  goodPoints: string[];
  /** 1~3개 */
  improvements: string[];
}

export interface LlmProfanityMatch {
  speaker: Speaker;
  /** 비속어 단어는 **** 로 치환된 마스킹 문장만 포함 (원문 비노출) */
  maskedText: string;
}

export interface LlmProfanityCheck {
  detected: boolean;
  matches: LlmProfanityMatch[];
}

export interface LlmPiiMatch {
  speaker: Speaker;
  /** PII 원문이 아니라 placeholder(예: "[전화번호]")로 치환된 문장만 포함 (원문 비노출) */
  maskedText: string;
}

/** profanityCheck와 동일한 방식(FR-6.1)으로 LLM에 요청하지 않고 로컬 detectPii()로 산출한다. */
export interface LlmPiiCheck {
  detected: boolean;
  matches: LlmPiiMatch[];
}

export interface LlmEvaluationResponse {
  /** evalSheet의 모든 itemId에 대해 1건씩, 누락/중복/미지 itemId 불가 */
  items: LlmItemResult[];
  providerMeta: LlmProviderMeta;
  coaching: LlmCoaching;
  profanityCheck: LlmProfanityCheck;
  piiCheck: LlmPiiCheck;
}

export interface LlmEvaluationProvider {
  evaluate(request: LlmEvaluationRequest): Promise<LlmEvaluationResponse>;
}

/** NestJS DI 토큰 */
export const LLM_EVALUATION_PROVIDER = Symbol('LLM_EVALUATION_PROVIDER');
