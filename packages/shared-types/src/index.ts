/**
 * Auto QA — FE/BE 공유 DTO 타입 정의
 *
 * Phase 1(Vertical Slice) 범위: 통신(telecom) 도메인 1건, Mock LLM.
 * 참고: docs/requirements/phase1-vertical-slice.md §4, docs/design/phase1-vertical-slice-ui-spec.md §3.2
 */

/** 평가시트 10종 도메인 ID (docs/architecture/eval-sheet-schema.md 기준) */
export const DOMAIN_IDS = [
  'finance-banking-card',
  'insurance',
  'telecom',
  'ecommerce-retail',
  'public-service',
  'healthcare',
  'it-support',
  'travel-lodging',
  'delivery-o2o',
  'utility',
] as const;

export type DomainId = (typeof DOMAIN_IDS)[number];

/**
 * 실제로 채점 가능한 도메인.
 * FR-11(다중 도메인 지원)부로 10개 도메인 전부 지원한다(이전 Phase 1의 telecom 고정 제약 해제).
 */
export const SUPPORTED_DOMAIN_IDS: DomainId[] = [...DOMAIN_IDS];

export type Channel = 'voice' | 'chat';

/** 트랜스크립트 최소 길이(공백 제외 글자 수, FR-1.2). 프론트/백엔드 공통 상수(M-8). */
export const MIN_TRANSCRIPT_NON_WHITESPACE_LENGTH = 10;

/** 공백 제외 글자 수를 계산한다(FR-1.2). 프론트/백엔드 공통 유틸(M-8). */
export function countNonWhitespace(text: string): number {
  return text.replace(/\s/g, '').length;
}

export interface TranscriptMetadata {
  agentId?: string;
  consultedAt?: string; // ISO8601
  channel?: Channel;
}

/** POST /transcripts 요청 바디 (요구사항 §4.1) */
export interface CreateTranscriptRequest {
  domainId: DomainId;
  rawText: string;
  metadata?: TranscriptMetadata;
}

/** POST /transcripts 응답 바디 — 결과 화면으로 바로 이동할 수 있도록 id 반환 */
export interface CreateTranscriptResponse {
  transcriptId: string;
  evaluationId: string;
}

export type PassFail = 'P' | 'F';
export type Grade = '우수' | '양호' | '보통' | '미흡';
export type GatingResult = '통과' | '탈락(재검토 필요)';
export type Speaker = 'customer' | 'agent';
export type LlmProviderId = 'mock' | 'anthropic' | 'gemini';
/** Phase 1 확장: 스코어 검증 실패 후 재시도까지 실패한 경우 수동 검토 상태로 저장한다. */
export type EvaluationStatus = 'completed' | 'manual_review';

export interface EvaluationItemResult {
  itemId: string;
  categoryId: string;
  itemName: string;
  criteria: string;
  score: number;
  maxScore: number;
  reason: string;
  gating: boolean;
  /** gating=true 항목만 존재 */
  passFail?: PassFail;
  /** 최초 AI 채점 점수. 보정(Override) 시에만 값이 채워지며, 최초 1회만 기록된다(FR-10.3). */
  originalScore?: number | null;
  /** QA 관리자가 점수를 수동 보정했는지 여부(FR-10) */
  overridden?: boolean;
  /** 보정 사유(선택) */
  overrideNote?: string | null;
  /** 보정자 식별(자유 텍스트, 인증 없음 — FR-10.6) */
  overrideReviewer?: string | null;
  /** 보정 시각(ISO8601) */
  overriddenAt?: string | null;
}

/** PATCH /evaluations/:id/items/:itemId 요청 바디 (FR-10, §4.5) */
export interface OverrideItemScoreRequest {
  /** 0 <= score <= item.maxScore, 정수 */
  score: number;
  /** 보정 사유(선택) */
  note?: string;
  /** 평가자 식별(자유 텍스트, 선택) */
  reviewer?: string;
}

export interface CategoryScoreResult {
  categoryId: string;
  categoryName: string;
  score: number;
  maxScore: number;
}

export interface ProfanityMatch {
  speaker: Speaker;
  /** 비속어 단어 자체는 **** 로 치환된 문장 (원문 비노출) */
  maskedText: string;
}

export interface FailedGatingItem {
  itemId: string;
  itemName: string;
  reason: string;
}

/**
 * PII 마스킹 종류(Phase 3 FR-4, `packages/pii-mask`의 `PiiKind`와 동일한 5종을 유지한다).
 * shared-types는 pii-mask 패키지에 의존하지 않으므로 값 집합을 여기 독립적으로 선언한다.
 */
export type PiiKind = 'rrn' | 'phone' | 'card' | 'account' | 'email';

/** 마스킹 종류별 탐지 건수(원문 조각은 포함하지 않음, FR-4.2). */
export type MaskingSummary = Record<PiiKind, number>;

/** GET /transcripts/:id 응답 바디 (요구사항 §4.4 저장 스키마 + UI 설계서 §3.2 표시용 확장) */
export interface EvaluationResultResponse {
  id: string;
  transcriptId: string;
  domainId: DomainId;
  domainName: string;
  evalSheetVersion: string;
  llmProvider: LlmProviderId;
  llmModel: string;
  status: EvaluationStatus;
  items: EvaluationItemResult[];
  categoryScores: CategoryScoreResult[];
  totalScore: number;
  totalMaxScore: number;
  grade: Grade;
  gatingResult: GatingResult;
  failedGatingItems: FailedGatingItem[];
  goodPoints: string[];
  improvements: string[];
  profanityDetected: boolean;
  profanityMatches: ProfanityMatch[];
  sourceCitation?: string;
  disclaimer?: string;
  createdAt: string;
  /**
   * PII 마스킹 종류별 탐지 건수(Phase 3 FR-4). Phase 3 이전에 저장된 레거시 레코드는
   * 집계 자체가 없으므로 `null`이 내려간다(원문을 저장하지 않아 소급 재계산이 불가능하다,
   * §9 Out of scope).
   */
  maskingSummary?: MaskingSummary | null;
}

export interface ApiErrorResponse {
  statusCode: number;
  message: string;
  error?: string;
}
