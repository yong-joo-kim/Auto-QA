import { BadGatewayException } from '@nestjs/common';
import { EvalSheet } from '@auto-qa/eval-schema';
import { EvaluationService } from './evaluation.service';
import {
  LlmEvaluationProvider,
  LlmEvaluationRequest,
  LlmEvaluationResponse,
} from './llm/llm-evaluation-provider.interface';
import { MockLlmEvaluationProvider } from './llm/mock-llm-evaluation.provider';
import { loadEvalSheet } from '@auto-qa/eval-schema';

/**
 * 회귀 테스트 대상: apps/api/src/evaluation/evaluation.service.ts,
 * apps/api/src/evaluation/llm/schema-builder.ts
 *
 * 참고: docs/review/phase1-vertical-slice-review-round2.md §test-automation 인계 사항
 * (재리뷰에서 실측한 계약위반 15종 / 값 범위 위반 13종 / 재시도 성공 경로 / Mock 결정론성)
 *
 * 이 스펙은 evaluation.service.ts, schema-builder.ts만을 대상으로 하며 packages/pii-mask
 * (M-3/M-4, 비속어/계좌번호 오탐)는 이번 회귀 테스트 범위에서 제외한다(PM 지시).
 */

// ── 테스트용 최소 평가시트(카테고리 2, 항목 3, 게이팅 1) ─────────────────────
const BASE_SHEET: EvalSheet = {
  domainId: 'test-domain',
  domainName: '테스트 도메인',
  version: '1.0.0',
  totalMaxScore: 20,
  gradeCriteria: [
    { minScore: 90, grade: '우수' },
    { minScore: 80, grade: '양호' },
    { minScore: 70, grade: '보통' },
    { minScore: 0, grade: '미흡' },
  ],
  categories: [
    {
      categoryId: 'cat-a',
      categoryName: 'A',
      maxScore: 10,
      items: [
        { itemId: 'item-1', itemName: 'Item1', criteria: 'c1', maxScore: 5, gating: false },
        { itemId: 'item-2', itemName: 'Item2', criteria: 'c2', maxScore: 5, gating: false },
      ],
    },
    {
      categoryId: 'cat-b',
      categoryName: 'B',
      maxScore: 10,
      items: [{ itemId: 'item-3', itemName: 'Item3', criteria: 'c3', maxScore: 10, gating: true }],
    },
  ],
};

/** 매번 새 객체를 반환한다(테스트 간 참조 공유로 인한 오염 방지). */
function buildValidResponse(): LlmEvaluationResponse {
  return {
    items: [
      { itemId: 'item-1', score: 4, reason: '사유1' },
      { itemId: 'item-2', score: 3, reason: '사유2' },
      { itemId: 'item-3', score: 8, reason: '사유3', passFail: 'P' },
    ],
    providerMeta: { provider: 'test', model: 'test-v1', latencyMs: 10 },
    coaching: { goodPoints: ['좋은 점1'], improvements: ['개선 점1'] },
    profanityCheck: { detected: false, matches: [] },
    piiCheck: { detected: false, matches: [] },
  };
}

function createFakeProvider(): LlmEvaluationProvider & { evaluate: jest.Mock } {
  return {
    evaluate: jest.fn<Promise<LlmEvaluationResponse>, [LlmEvaluationRequest]>(),
  } as unknown as LlmEvaluationProvider & { evaluate: jest.Mock };
}

async function expectBadGateway(promise: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  // 예외가 던져지지 않았다면(caught === undefined) 아래 두 단언이 실패하여 테스트가 실패한다.
  expect(caught).toBeInstanceOf(BadGatewayException);
  expect((caught as BadGatewayException)?.getStatus()).toBe(502);
}

describe('EvaluationService — 구조적 계약 위반 → 502 (BadGatewayException)', () => {
  const cases: Array<[string, (r: any) => any]> = [
    [
      'coaching 누락',
      (r) => {
        delete r.coaching;
        return r;
      },
    ],
    [
      'coaching null',
      (r) => {
        r.coaching = null;
        return r;
      },
    ],
    [
      'profanityCheck 누락',
      (r) => {
        delete r.profanityCheck;
        return r;
      },
    ],
    [
      'piiCheck 누락',
      (r) => {
        delete r.piiCheck;
        return r;
      },
    ],
    [
      'goodPoints: [] (AC-12 위반)',
      (r) => {
        r.coaching.goodPoints = [];
        return r;
      },
    ],
    [
      'goodPoints 4개(1~3개 초과)',
      (r) => {
        r.coaching.goodPoints = ['a', 'b', 'c', 'd'];
        return r;
      },
    ],
    [
      'goodPoints가 문자열(배열 아님)',
      (r) => {
        r.coaching.goodPoints = '문자열';
        return r;
      },
    ],
    [
      'goodPoints: [""] (빈 문자열)',
      (r) => {
        r.coaching.goodPoints = [''];
        return r;
      },
    ],
    [
      'profanityCheck.detected:true & matches:[]',
      (r) => {
        r.profanityCheck = { detected: true, matches: [] };
        return r;
      },
    ],
    [
      'matches[].speaker enum 위반("bot")',
      (r) => {
        r.profanityCheck = { detected: true, matches: [{ speaker: 'bot', maskedText: '****' }] };
        return r;
      },
    ],
    [
      'piiCheck.detected:true & matches:[]',
      (r) => {
        r.piiCheck = { detected: true, matches: [] };
        return r;
      },
    ],
    [
      'piiCheck matches[].speaker enum 위반("bot")',
      (r) => {
        r.piiCheck = { detected: true, matches: [{ speaker: 'bot', maskedText: '[전화번호]' }] };
        return r;
      },
    ],
    [
      'providerMeta 누락',
      (r) => {
        delete r.providerMeta;
        return r;
      },
    ],
    [
      'items 항목 누락(item-3 제외)',
      (r) => {
        r.items = r.items.filter((i: any) => i.itemId !== 'item-3');
        return r;
      },
    ],
    [
      'items 중복(item-1 중복 포함)',
      (r) => {
        r.items = [...r.items, { ...r.items[0] }];
        return r;
      },
    ],
    [
      'items에 미지 itemId 포함',
      (r) => {
        r.items = [...r.items, { itemId: 'unknown-item', score: 1, reason: 'x' }];
        return r;
      },
    ],
    [
      'items가 배열이 아님',
      (r) => {
        r.items = {};
        return r;
      },
    ],
  ];

  test.each(cases)('%s → 502로 거부되고 저장되지 않는다', async (_name, mutate) => {
    const response = mutate(buildValidResponse());
    const provider = createFakeProvider();
    provider.evaluate.mockResolvedValue(response);
    const service = new EvaluationService(provider);

    await expectBadGateway(service.evaluateAndAggregate('test-domain', '마스킹된 텍스트', BASE_SHEET));
  });

  test('응답 자체가 null → 502로 거부되고 저장되지 않는다', async () => {
    const provider = createFakeProvider();
    provider.evaluate.mockResolvedValue(null as unknown as LlmEvaluationResponse);
    const service = new EvaluationService(provider);

    await expectBadGateway(service.evaluateAndAggregate('test-domain', '마스킹된 텍스트', BASE_SHEET));
  });
});

describe('EvaluationService — 값 범위 위반 → 재시도 후 clamp → status="manual_review"', () => {
  const cases: Array<[string, string, (item: any) => any]> = [
    [
      'score 누락',
      'item-2',
      (item) => {
        delete item.score;
        return item;
      },
    ],
    [
      'score "5"(숫자형 문자열)',
      'item-2',
      (item) => {
        item.score = '5';
        return item;
      },
    ],
    [
      'score NaN',
      'item-2',
      (item) => {
        item.score = NaN;
        return item;
      },
    ],
    [
      'score null',
      'item-2',
      (item) => {
        item.score = null;
        return item;
      },
    ],
    [
      'score "abc"',
      'item-2',
      (item) => {
        item.score = 'abc';
        return item;
      },
    ],
    [
      'score Infinity',
      'item-2',
      (item) => {
        item.score = Infinity;
        return item;
      },
    ],
    [
      'score 999(배점 초과)',
      'item-2',
      (item) => {
        item.score = 999;
        return item;
      },
    ],
    [
      'score -5(음수)',
      'item-2',
      (item) => {
        item.score = -5;
        return item;
      },
    ],
    [
      'score 3.7(소수)',
      'item-2',
      (item) => {
        item.score = 3.7;
        return item;
      },
    ],
    [
      'reason 누락',
      'item-2',
      (item) => {
        delete item.reason;
        return item;
      },
    ],
    [
      'reason 공백',
      'item-2',
      (item) => {
        item.reason = '   ';
        return item;
      },
    ],
    [
      'reason이 숫자',
      'item-2',
      (item) => {
        item.reason = 123;
        return item;
      },
    ],
    [
      '게이팅 항목의 passFail 누락',
      'item-3',
      (item) => {
        delete item.passFail;
        return item;
      },
    ],
  ];

  test.each(cases)(
    '%s → 재시도 후에도 위반 지속 시 manual_review + 값이 안전 범위로 보정된다',
    async (_name, itemId, mutate) => {
      const response = buildValidResponse() as any;
      response.items = response.items.map((it: any) => (it.itemId === itemId ? mutate({ ...it }) : it));

      const provider = createFakeProvider();
      // 1차/재시도 모두 동일한 위반 응답을 반환 → 보정 후 manual_review로 귀결되어야 한다.
      provider.evaluate.mockResolvedValue(response);
      const service = new EvaluationService(provider);

      const result = await service.evaluateAndAggregate('test-domain', '마스킹된 텍스트', BASE_SHEET);

      expect(result.status).toBe('manual_review');
      expect(Number.isFinite(result.totalScore)).toBe(true);
      expect(result.items.every((i) => Number.isInteger(i.score))).toBe(true);
      expect(result.items.every((i) => i.score >= 0 && i.score <= i.maxScore)).toBe(true);
      // 최초 1회 + 재시도 1회, 최대 1회 재시도 원칙(NFR-3.3) 준수 확인
      expect(provider.evaluate).toHaveBeenCalledTimes(2);
    },
  );
});

describe('EvaluationService — 재시도 성공 경로', () => {
  test('1차 범위 위반(score 초과) → 2차 정상 응답이면 status="completed"로 유지된다', async () => {
    const invalidResponse = buildValidResponse() as any;
    invalidResponse.items = invalidResponse.items.map((it: any) =>
      it.itemId === 'item-2' ? { ...it, score: 999 } : it,
    );
    const validResponse = buildValidResponse();

    const provider = createFakeProvider();
    provider.evaluate.mockResolvedValueOnce(invalidResponse).mockResolvedValueOnce(validResponse);
    const service = new EvaluationService(provider);

    const result = await service.evaluateAndAggregate('test-domain', '마스킹된 텍스트', BASE_SHEET);

    expect(result.status).toBe('completed');
    expect(provider.evaluate).toHaveBeenCalledTimes(2);
    const item2 = result.items.find((i) => i.itemId === 'item-2');
    // manual_review로 불필요하게 승격되지 않고, 재시도(2차) 응답 값이 그대로 반영되어야 한다.
    expect(item2?.score).toBe(3);
  });

  test('1차 구조 위반(items 누락)은 재시도 없이 즉시 502로 거부된다(구조 위반은 재시도 대상 아님)', async () => {
    const structurallyInvalid = buildValidResponse() as any;
    delete structurallyInvalid.providerMeta;

    const provider = createFakeProvider();
    provider.evaluate.mockResolvedValue(structurallyInvalid);
    const service = new EvaluationService(provider);

    await expectBadGateway(service.evaluateAndAggregate('test-domain', '마스킹된 텍스트', BASE_SHEET));
    expect(provider.evaluate).toHaveBeenCalledTimes(1);
  });
});

describe('EvaluationService + MockLlmEvaluationProvider — 결정론성(AC-8)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // 지연 시뮬레이션(500~2000ms)을 0으로 낮춰 테스트를 빠르게 하고,
    // 오류 주입/강제 무효화 플래그가 우연히 켜져 있지 않도록 초기화한다.
    process.env.MOCK_LLM_MIN_LATENCY_MS = '0';
    process.env.MOCK_LLM_MAX_LATENCY_MS = '0';
    process.env.MOCK_LLM_FAILURE_RATE = '0';
    delete process.env.MOCK_LLM_FORCE_INVALID;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('동일 트랜스크립트로 2회 평가 시 항목별 score/reason/passFail이 완전히 일치한다(latencyMs 제외)', async () => {
    const evalSheet = loadEvalSheet('telecom');
    const maskedTranscript = '상담사: 안녕하세요 고객님. 고객: 요금제 변경 문의드립니다.';

    const service1 = new EvaluationService(new MockLlmEvaluationProvider());
    const service2 = new EvaluationService(new MockLlmEvaluationProvider());

    const result1 = await service1.evaluateAndAggregate('telecom', maskedTranscript, evalSheet);
    const result2 = await service2.evaluateAndAggregate('telecom', maskedTranscript, evalSheet);

    const normalize = (items: typeof result1.items) =>
      items.map((i) => ({ itemId: i.itemId, score: i.score, reason: i.reason, passFail: i.passFail }));

    expect(normalize(result1.items)).toEqual(normalize(result2.items));
    expect(result1.totalScore).toBe(result2.totalScore);
    expect(result1.gatingResult).toBe(result2.gatingResult);
    expect(result1.grade).toBe(result2.grade);
    // latencyMs는 비결정론적이므로(§L-7) 비교 대상에서 명시적으로 제외한다.
  });
});
