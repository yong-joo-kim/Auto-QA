import { Injectable } from '@nestjs/common';
import { detectProfanity } from '@auto-qa/pii-mask';
import {
  LlmCoaching,
  LlmEvaluationProvider,
  LlmEvaluationRequest,
  LlmEvaluationResponse,
  LlmItemResult,
} from './llm-evaluation-provider.interface';

/**
 * Mock LLM 어댑터.
 * 참고: docs/requirements/phase1-vertical-slice.md §4.3 (Mock LLM 어댑터 동작 규칙 1~11)
 *
 * 실제 LLM API 키 없이도 채점 로직/집계/게이팅/UI를 의미 있게 검증할 수 있도록
 * 결정론적 의사난수(hash(maskedTranscript + itemId) 시드)로 점수를 산출한다.
 * 동일 트랜스크립트 + 동일 평가시트 버전이면 항상 동일한 결과가 나온다(§4.3-1, AC-8).
 *
 * 사유(reason)/코칭 문구는 모두 "고정 템플릿 기반"이다(§4.3-5, §4.3-11) — 실제 LLM이
 * 생성한 것처럼 보이도록 문장을 구성하되, 각 문장은 아래 TEMPLATE 상수에서 파생된다.
 */
@Injectable()
export class MockLlmEvaluationProvider implements LlmEvaluationProvider {
  async evaluate(request: LlmEvaluationRequest): Promise<LlmEvaluationResponse> {
    this.maybeInjectFailure();

    const latencyMs = this.computeSimulatedLatency();
    await sleep(latencyMs);

    const { maskedTranscript, evalSheet } = request;

    const items: LlmItemResult[] = [];
    const categoryStats = new Map<
      string,
      { categoryName: string; sum: number; max: number }
    >();

    // MOCK_LLM_FORCE_INVALID=1이면 첫 번째 항목의 score를 강제로 배점 초과시켜
    // NFR-3.3/AC-9(서버 측 배점 초과 방어 검증)를 재현 가능하게 한다(테스트 전용).
    let alreadyForcedInvalid = process.env.MOCK_LLM_FORCE_INVALID !== '1';

    for (const category of evalSheet.categories) {
      const stat = categoryStats.get(category.categoryId) ?? {
        categoryName: category.categoryName,
        sum: 0,
        max: 0,
      };

      for (const item of category.items) {
        const rng = createItemRng(maskedTranscript, item.itemId);
        let scoreRatio: number;
        let passFail: 'P' | 'F' | undefined;

        if (item.gating) {
          const gateDraw = rng();
          const isFail = gateDraw < GATING_FAIL_PROBABILITY;
          passFail = isFail ? 'F' : 'P';
          scoreRatio = isFail ? rng() * 0.3 : sampleGeneralScoreRatio(rng);
        } else {
          scoreRatio = sampleGeneralScoreRatio(rng);
        }

        let score = clampRound(scoreRatio * item.maxScore, item.maxScore);

        if (!alreadyForcedInvalid) {
          score = item.maxScore + 1;
          alreadyForcedInvalid = true;
        }

        items.push({ itemId: item.itemId, score, reason: buildReason(item.itemName, scoreRatio, passFail), passFail });

        stat.sum += score;
        stat.max += item.maxScore;
      }

      categoryStats.set(category.categoryId, stat);
    }

    const gatingFailedItems = evalSheet.categories
      .flatMap((c) => c.items.map((i) => ({ ...i, categoryId: c.categoryId })))
      .filter((i) => items.find((r) => r.itemId === i.itemId)?.passFail === 'F');

    const coaching = buildCoaching(evalSheet, items, categoryStats, gatingFailedItems);
    const profanityCheck = detectProfanity(maskedTranscript);

    return {
      items,
      providerMeta: {
        provider: 'mock',
        model: 'mock-v1',
        latencyMs,
      },
      coaching,
      profanityCheck,
    };
  }

  private maybeInjectFailure(): void {
    const rate = Number(process.env.MOCK_LLM_FAILURE_RATE ?? '0');
    if (rate > 0 && Math.random() < rate) {
      throw new Error('MOCK_LLM_INJECTED_FAILURE: 오류 주입 설정(MOCK_LLM_FAILURE_RATE)에 의해 실패했습니다.');
    }
  }

  private computeSimulatedLatency(): number {
    const min = Number(process.env.MOCK_LLM_MIN_LATENCY_MS ?? '500');
    const max = Number(process.env.MOCK_LLM_MAX_LATENCY_MS ?? '2000');
    const span = Math.max(0, max - min);
    return Math.round(min + Math.random() * span);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── 결정론적 PRNG ────────────────────────────────────────────────────────

/** FNV-1a 기반 문자열 해시 (32bit) */
function hashStringToInt(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 시드 기반 PRNG — 동일 seed면 항상 동일한 [0,1) 수열을 생성 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return function random() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** hash(maskedTranscript + itemId)를 시드로 하는 항목 전용 PRNG 생성 (§4.3-1) */
function createItemRng(maskedTranscript: string, itemId: string): () => number {
  const seed = hashStringToInt(`${maskedTranscript}::${itemId}`);
  return mulberry32(seed);
}

// ── 점수 분포 ────────────────────────────────────────────────────────────

/** 게이팅 F(실패) 확률: 8~12% 범위 내 고정값(시드 기반으로 gate 여부를 판정하는 임계값) */
const GATING_FAIL_PROBABILITY = 0.1;
/** 일반 항목의 저점 구간(40~60%) 편향 확률: 15~20% 범위 내 고정값 */
const LOW_BAND_PROBABILITY = 0.175;

/** "양호한 상담원" 시뮬레이션: 60~100% 구간에 편향, 15~20% 확률로 40~60% 저점 구간 */
function sampleGeneralScoreRatio(rng: () => number): number {
  const branchDraw = rng();
  if (branchDraw < LOW_BAND_PROBABILITY) {
    return 0.4 + rng() * 0.2; // 40~60%
  }
  return 0.6 + rng() * 0.4; // 60~100%
}

function clampRound(value: number, max: number): number {
  return Math.min(max, Math.max(0, Math.round(value)));
}

// ── 사유(reason) 템플릿 (§4.3-5) ────────────────────────────────────────

function buildReason(itemName: string, scoreRatio: number, passFail?: 'P' | 'F'): string {
  if (passFail === 'F') {
    return `${itemName} 절차가 충분히 이행되지 않아 게이팅 기준을 충족하지 못함(F) — 재검토 필요`;
  }
  if (scoreRatio >= 0.9) {
    return `${itemName} 항목에서 기준을 충분히 상회하는 우수한 수행을 보임 — 기준 충족`;
  }
  if (scoreRatio >= 0.7) {
    return `${itemName} 항목의 기준을 대체로 충족함 — 양호`;
  }
  if (scoreRatio >= 0.5) {
    return `${itemName} 항목에서 일부 기준 이행이 미흡하여 보완이 필요함 — 보통`;
  }
  return `${itemName} 항목의 기준 이행이 충분하지 않아 개선이 필요함 — 미흡`;
}

// ── AI 코칭 요약 템플릿 (§4.3-11, FR-9) ─────────────────────────────────

interface GatingFailedItemLike {
  itemId: string;
  itemName: string;
  categoryId: string;
}

function buildCoaching(
  evalSheet: LlmEvaluationRequest['evalSheet'],
  items: LlmItemResult[],
  categoryStats: Map<string, { categoryName: string; sum: number; max: number }>,
  gatingFailedItems: GatingFailedItemLike[],
): LlmCoaching {
  const categoryRatios = [...categoryStats.entries()].map(([categoryId, stat]) => ({
    categoryId,
    categoryName: stat.categoryName,
    ratio: stat.max > 0 ? stat.sum / stat.max : 0,
  }));
  categoryRatios.sort((a, b) => b.ratio - a.ratio);
  const bestCategory = categoryRatios[0];
  const worstCategory = categoryRatios[categoryRatios.length - 1];

  const itemById = new Map(
    evalSheet.categories.flatMap((c) => c.items.map((i) => [i.itemId, { ...i, categoryId: c.categoryId }])),
  );
  const itemRatios = items.map((r) => {
    const meta = itemById.get(r.itemId)!;
    return { itemId: r.itemId, itemName: meta.itemName, categoryId: meta.categoryId, ratio: meta.maxScore > 0 ? r.score / meta.maxScore : 0 };
  });
  itemRatios.sort((a, b) => b.ratio - a.ratio);
  const bestItem = itemRatios[0];
  const worstItem = itemRatios[itemRatios.length - 1];

  const goodPoints: string[] = [];
  goodPoints.push(
    `${bestCategory.categoryName} 영역에서 특히 안정적인 상담 역량을 보여주고 있어요. 이 부분은 계속 유지해주세요.`,
  );
  if (bestItem.categoryId !== bestCategory.categoryId) {
    goodPoints.push(`특히 '${bestItem.itemName}' 항목에서 좋은 모습을 보였어요.`);
  } else if (gatingFailedItems.length === 0) {
    goodPoints.push('컴플라이언스 관련 게이팅 항목을 모두 통과해 안정적인 상담 품질을 유지했어요.');
  }

  const improvements: string[] = [];
  improvements.push(
    `${worstCategory.categoryName} 영역은 상대적으로 점수가 낮아요. 관련 절차를 다시 한 번 점검해보면 좋겠습니다.`,
  );
  if (gatingFailedItems.length > 0) {
    for (const failed of gatingFailedItems.slice(0, 2)) {
      improvements.push(
        `'${failed.itemName}'(게이팅 항목) 이행이 미흡하여 탈락 판정을 받았어요. 관련 절차를 최우선으로 개선해주세요.`,
      );
    }
  } else if (worstItem.categoryId !== worstCategory.categoryId) {
    improvements.push(`'${worstItem.itemName}' 항목도 함께 보완하면 더 좋을 것 같아요.`);
  }

  return {
    goodPoints: goodPoints.slice(0, 3),
    improvements: improvements.slice(0, 3),
  };
}
