import { BadGatewayException, Inject, Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { EvalSheet, indexItems, resolveGrade } from '@auto-qa/eval-schema';
import {
  CategoryScoreResult,
  EvaluationItemResult,
  EvaluationStatus,
  FailedGatingItem,
  Grade,
  GatingResult,
  PassFail,
  ProfanityMatch,
} from '@auto-qa/shared-types';
import { buildLlmResponseZodSchema } from './llm/schema-builder';
import {
  LLM_EVALUATION_PROVIDER,
  LlmEvaluationProvider,
  LlmEvaluationRequest,
  LlmEvaluationResponse,
  LlmProviderMeta,
} from './llm/llm-evaluation-provider.interface';

export interface AggregatedEvaluation {
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
  llmProviderMeta: LlmProviderMeta;
}

/** aggregateFromScoredItems가 받는 최소 입력 형태. LlmItemResult/EvaluationItemResult 둘 다 구조적으로 호환된다. */
interface ScoredItemLike {
  itemId: string;
  score: number;
  reason: string;
  passFail?: PassFail;
  originalScore?: number | null;
  overridden?: boolean;
  overrideNote?: string | null;
  overrideReviewer?: string | null;
  overriddenAt?: string | null;
}

type AggregationCore = Pick<
  AggregatedEvaluation,
  'items' | 'categoryScores' | 'totalScore' | 'totalMaxScore' | 'grade' | 'gatingResult' | 'failedGatingItems'
>;

/**
 * 채점 요청 오케스트레이션 + 서버 측 재계산/검증.
 *
 * 핵심 원칙(CLAUDE.md):
 *  - LLM이 반환한 값을 그대로 신뢰하지 않고 서버가 항상 Σ item.score를 재계산한다(NFR-5.1).
 *  - 구조적 계약 위반(항목 누락/중복/미지 itemId, coaching/profanityCheck 형식 위반) → 502로 즉시
 *    거부, 저장하지 않는다(NFR-3.3, H-2).
 *  - 스코어 범위 초과/비정수/reason 누락/게이팅 passFail 누락(값 범위 위반) → 최대 1회 재시도,
 *    그래도 실패하면 값을 안전하게 보정한 뒤 status="manual_review"로 저장한다(수동 검토 필요).
 */
@Injectable()
export class EvaluationService {
  private readonly logger = new Logger(EvaluationService.name);

  constructor(
    @Inject(LLM_EVALUATION_PROVIDER)
    private readonly llmProvider: LlmEvaluationProvider,
  ) {}

  async evaluateAndAggregate(
    domainId: string,
    maskedTranscript: string,
    evalSheet: EvalSheet,
  ): Promise<AggregatedEvaluation> {
    const request: LlmEvaluationRequest = { domainId, maskedTranscript, evalSheet };

    let response = await this.invokeProvider(request);
    this.assertStructuralContract(response, evalSheet);

    let rangeErrors = validateScoreRanges(response, evalSheet);
    let status: EvaluationStatus = 'completed';

    if (rangeErrors.length > 0) {
      // N-2: 값 범위 위반 사유를 남긴다. itemId/검증 사유 문자열만 기록하고, 원문/마스킹된
      // 트랜스크립트 텍스트는 절대 포함하지 않는다(NFR-1.2, M-5와 동일 원칙).
      this.logger.warn(`값 범위 위반 감지, 재시도합니다 (domainId=${domainId}): ${rangeErrors.join('; ')}`);

      const retryResponse = await this.invokeProvider(request);
      this.assertStructuralContract(retryResponse, evalSheet);
      const retryRangeErrors = validateScoreRanges(retryResponse, evalSheet);

      if (retryRangeErrors.length === 0) {
        response = retryResponse;
      } else {
        this.logger.warn(
          `재시도 후에도 값 범위 위반이 지속되어 manual_review로 저장합니다 (domainId=${domainId}): ${retryRangeErrors.join('; ')}`,
        );
        response = sanitizeForManualReview(retryResponse, evalSheet);
        status = 'manual_review';
      }
    }

    const aggregation = aggregateFromScoredItems(response.items, evalSheet);
    return {
      status,
      ...aggregation,
      goodPoints: response.coaching.goodPoints,
      improvements: response.coaching.improvements,
      profanityDetected: response.profanityCheck.detected,
      profanityMatches: response.profanityCheck.matches,
      llmProviderMeta: response.providerMeta,
    };
  }

  private async invokeProvider(request: LlmEvaluationRequest): Promise<LlmEvaluationResponse> {
    try {
      return await this.llmProvider.evaluate(request);
    } catch (error) {
      // NOTE: 에러 로그에도 maskedTranscript 원문/마스킹 텍스트 스니펫을 남기지 않는다(NFR-1.2, M-5).
      const providerName = this.llmProvider.constructor?.name ?? 'unknown';
      const errorClassName = error instanceof Error ? error.constructor.name : typeof error;
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `LLM 채점 요청 실패 (provider=${providerName}, errorClass=${errorClassName}): ${errorMessage}`,
      );
      throw new InternalServerErrorException(
        'LLM 채점 요청 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
      );
    }
  }

  private assertStructuralContract(response: LlmEvaluationResponse, evalSheet: EvalSheet): void {
    const errors = validateResponseStructure(response, evalSheet);
    if (errors.length > 0) {
      throw new BadGatewayException(`LLM 응답이 계약을 위반했습니다: ${errors.join('; ')}`);
    }
  }
}

// ── 검증 ─────────────────────────────────────────────────────────────────

/**
 * 구조적 계약 위반 검증(H-2): 항목 누락/중복/미지 itemId, coaching(goodPoints/improvements
 * 1~3개 비어있지 않은 문자열)·profanityCheck(detected boolean, matches[].speaker enum) 형식
 * 위반을 zod 스키마 하나로 통합 검증한다(`schema-builder.ts`와 공유, 중복 제거).
 */
function validateResponseStructure(response: LlmEvaluationResponse, evalSheet: EvalSheet): string[] {
  const schema = buildLlmResponseZodSchema(evalSheet);
  const result = schema.safeParse(response);
  if (result.success) return [];
  return result.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
    return `${path}${issue.message}`;
  });
}

/**
 * 값 범위 위반 검증(NFR-3.3의 "값 범위 위반" 버킷 — 최대 1회 재시도 후 clamp):
 *  - score가 maxScore를 초과/음수/유한하지 않음(H-1 관련 방어)
 *  - score가 정수가 아님(M-1)
 *  - reason이 비어있는 문자열(M-2)
 *  - 게이팅 항목인데 passFail이 P/F가 아님
 */
function validateScoreRanges(response: LlmEvaluationResponse, evalSheet: EvalSheet): string[] {
  const index = indexItems(evalSheet);
  const errors: string[] = [];

  for (const result of response.items) {
    const entry = index.get(result.itemId);
    if (!entry) continue; // 구조적 오류는 별도 검증에서 처리

    const { item } = entry;

    if (!Number.isFinite(result.score) || result.score < 0 || result.score > item.maxScore) {
      errors.push(`itemId=${result.itemId} score(${result.score})가 허용 범위(0~${item.maxScore})를 벗어났습니다.`);
    } else if (!Number.isInteger(result.score)) {
      errors.push(`itemId=${result.itemId} score(${result.score})는 정수여야 합니다.`);
    }

    if (typeof result.reason !== 'string' || result.reason.trim().length === 0) {
      errors.push(`itemId=${result.itemId}의 reason이 비어 있습니다.`);
    }

    if (item.gating && result.passFail !== 'P' && result.passFail !== 'F') {
      errors.push(`itemId=${result.itemId}는 게이팅 항목이지만 passFail 값이 유효하지 않습니다.`);
    }
  }
  return errors;
}

/** 재시도까지 실패한 경우, 안전한 범위로 값을 보정한다(수동 검토용). */
function sanitizeForManualReview(response: LlmEvaluationResponse, evalSheet: EvalSheet): LlmEvaluationResponse {
  const index = indexItems(evalSheet);
  const items = response.items.map((result) => {
    const entry = index.get(result.itemId);
    if (!entry) return result;
    const { item } = entry;

    // H-1: score가 NaN/undefined/문자열 등 비유한값이면 Math.round가 이를 그대로 통과시키므로
    // Number.isFinite 가드를 거쳐 0으로 대체한 뒤 clamp한다.
    const rawScore = Number(result.score);
    const finiteScore = Number.isFinite(rawScore) ? rawScore : 0;
    const safeScore = Math.min(item.maxScore, Math.max(0, Math.round(finiteScore)));

    const safeReason =
      typeof result.reason === 'string' && result.reason.trim().length > 0
        ? result.reason
        : '자동 보정됨: LLM 응답에 유효한 사유가 없어 수동 검토가 필요합니다.';

    // 게이팅 항목의 passFail이 유효하지 않으면 보수적으로 'F'(탈락)로 간주한다.
    const safePassFail = item.gating
      ? result.passFail === 'P' || result.passFail === 'F'
        ? result.passFail
        : 'F'
      : undefined;

    return { ...result, score: safeScore, reason: safeReason, passFail: safePassFail };
  });

  return { ...response, items };
}

// ── 집계 ─────────────────────────────────────────────────────────────────

/**
 * 평가시트의 카테고리/항목 구조를 기준으로 채점 결과를 집계한다.
 *
 * 항목 수/배점/게이팅 항목 구성은 도메인마다 다를 수 있으므로(FR-11.3), 하드코딩된 항목 수에
 * 의존하지 않고 항상 `evalSheet.categories`를 순회하며 동적으로 집계한다.
 *
 * 두 경로에서 공유(재사용)된다:
 *  1. `evaluateAndAggregate` — LLM 응답(items: LlmItemResult[])으로부터 최초 집계
 *  2. `TranscriptsService.overrideItemScore` (FR-10) — 보정된 items(EvaluationItemResult[])로부터
 *     categoryScores/totalScore/grade/gatingResult 재계산(NFR-5.1과 동일 원칙)
 */
export function aggregateFromScoredItems(
  scoredItems: ScoredItemLike[],
  evalSheet: EvalSheet,
): AggregationCore {
  const resultByItemId = new Map(scoredItems.map((r) => [r.itemId, r]));
  const items: EvaluationItemResult[] = [];
  const categoryScores: CategoryScoreResult[] = [];
  const failedGatingItems: FailedGatingItem[] = [];
  let totalScore = 0;

  for (const category of evalSheet.categories) {
    let categoryScore = 0;

    for (const item of category.items) {
      const result = resultByItemId.get(item.itemId);
      if (!result) {
        // assertStructuralContract를 통과했다면(또는 override 대상이 evalSheet에 존재한다면)
        // 도달하지 않아야 한다(방어적 처리).
        throw new BadGatewayException(`채점 결과에서 itemId=${item.itemId} 결과를 찾을 수 없습니다.`);
      }

      categoryScore += result.score;
      totalScore += result.score;

      items.push({
        itemId: item.itemId,
        categoryId: category.categoryId,
        itemName: item.itemName,
        criteria: item.criteria,
        score: result.score,
        maxScore: item.maxScore,
        reason: result.reason,
        gating: item.gating,
        passFail: item.gating ? result.passFail : undefined,
        originalScore: result.originalScore ?? null,
        overridden: result.overridden ?? false,
        overrideNote: result.overrideNote ?? null,
        overrideReviewer: result.overrideReviewer ?? null,
        overriddenAt: result.overriddenAt ?? null,
      });

      if (item.gating && result.passFail === 'F') {
        failedGatingItems.push({ itemId: item.itemId, itemName: item.itemName, reason: result.reason });
      }
    }

    categoryScores.push({
      categoryId: category.categoryId,
      categoryName: category.categoryName,
      score: categoryScore,
      maxScore: category.maxScore,
    });
  }

  const gatingResult: GatingResult = failedGatingItems.length > 0 ? '탈락(재검토 필요)' : '통과';
  const grade = resolveGrade(totalScore, evalSheet) as Grade;

  return {
    items,
    categoryScores,
    totalScore,
    totalMaxScore: evalSheet.totalMaxScore,
    grade,
    gatingResult,
    failedGatingItems,
  };
}
