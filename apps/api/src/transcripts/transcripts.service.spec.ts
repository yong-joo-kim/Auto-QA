import { TranscriptsService } from './transcripts.service';
import { EvalSheetsService } from '../eval-sheets/eval-sheets.service';
import { EvaluationService, AggregatedEvaluation } from '../evaluation/evaluation.service';
import { EvalSheet } from '@auto-qa/eval-schema';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTranscriptRequest } from '@auto-qa/shared-types';

/**
 * 회귀 테스트 대상: apps/api/src/transcripts/transcripts.service.ts
 *
 * Phase 3 FR-4(마스킹 관측성) — `maskingSummary` 저장→조회 왕복과, 컬럼 값이 손상되어도
 * 결과 조회 API가 500으로 실패하지 않는지(`parseMaskingSummary` 방어) 검증한다.
 * 참고: docs/review/phase3-pii-hardening-review.md(M-5),
 *       docs/review/phase3-pii-hardening-review-round2.md §10 인계 사항.
 *
 * PrismaService는 실제 DB 대신 인메모리 Map 기반 fake로 대체한다(NestJS DI 컨테이너 미사용,
 * Phase 1 evaluation.service.spec.ts와 동일한 직접 인스턴스화 방식).
 */

const BASE_SHEET: EvalSheet = {
  domainId: 'telecom',
  domainName: '통신',
  version: '1.0.0',
  totalMaxScore: 10,
  gradeCriteria: [
    { minScore: 90, grade: '우수' },
    { minScore: 0, grade: '미흡' },
  ],
  sourceCitation: '스마트초이스(smartchoice.or.kr)',
  disclaimer: '배점 및 가중치는 참고용 설계 예시입니다.',
  categories: [
    {
      categoryId: 'cat-a',
      categoryName: 'A',
      maxScore: 10,
      items: [{ itemId: 'item-1', itemName: 'Item1', criteria: 'c1', maxScore: 10, gating: false }],
    },
  ],
};

function buildAggregation(): AggregatedEvaluation {
  return {
    status: 'completed',
    items: [
      {
        itemId: 'item-1',
        categoryId: 'cat-a',
        itemName: 'Item1',
        criteria: 'c1',
        score: 8,
        maxScore: 10,
        reason: '사유',
        gating: false,
      },
    ],
    categoryScores: [{ categoryId: 'cat-a', categoryName: 'A', score: 8, maxScore: 10 }],
    totalScore: 8,
    totalMaxScore: 10,
    grade: '양호',
    gatingResult: '통과',
    failedGatingItems: [],
    goodPoints: ['좋은 점'],
    improvements: ['개선 점'],
    profanityDetected: false,
    profanityMatches: [],
    llmProviderMeta: { provider: 'mock', model: 'mock-v1', latencyMs: 1 },
  };
}

interface FakeTranscriptRow {
  id: string;
  domainId: string;
  maskedText: string;
  metadata: string | null;
  maskingSummary: string | null;
}

interface FakeEvaluationRow {
  id: string;
  transcriptId: string;
  domainId: string;
  evalSheetVersion: string;
  llmProvider: string;
  llmModel: string;
  status: string;
  items: string;
  categoryScores: string;
  totalScore: number;
  totalMaxScore: number;
  grade: string;
  gatingResult: string;
  failedGatingItems: string;
  goodPoints: string;
  improvements: string;
  profanityDetected: boolean;
  profanityMatches: string;
  createdAt: Date;
}

/** 실 DB 대신 인메모리로 transcript/evaluation을 저장하는 최소 Prisma fake. */
function createFakePrisma() {
  let transcriptSeq = 0;
  let evaluationSeq = 0;
  const transcripts = new Map<string, FakeTranscriptRow>();
  const evaluations = new Map<string, FakeEvaluationRow>();

  const prisma = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        transcript: {
          create: async ({ data }: { data: Omit<FakeTranscriptRow, 'id'> }) => {
            transcriptSeq += 1;
            const row: FakeTranscriptRow = { id: `t-${transcriptSeq}`, ...data };
            transcripts.set(row.id, row);
            return row;
          },
        },
        evaluation: {
          create: async ({ data }: { data: Omit<FakeEvaluationRow, 'id' | 'createdAt'> }) => {
            evaluationSeq += 1;
            const row: FakeEvaluationRow = {
              id: `e-${evaluationSeq}`,
              createdAt: new Date('2026-09-12T00:00:00.000Z'),
              ...data,
            };
            evaluations.set(row.id, row);
            return row;
          },
        },
      };
      return fn(tx);
    },
    transcript: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const t = transcripts.get(where.id);
        if (!t) return null;
        const evaluation = [...evaluations.values()].find((e) => e.transcriptId === t.id) ?? null;
        return { ...t, evaluation };
      },
    },
    evaluation: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const e = evaluations.get(where.id);
        if (!e) return null;
        const transcript = transcripts.get(e.transcriptId) ?? null;
        return { ...e, transcript };
      },
    },
    __transcripts: transcripts,
  };

  return prisma;
}

function createService(prisma: ReturnType<typeof createFakePrisma>) {
  const evalSheets = { getSheet: jest.fn().mockReturnValue(BASE_SHEET) } as unknown as EvalSheetsService;
  const evaluationService = {
    evaluateAndAggregate: jest.fn().mockResolvedValue(buildAggregation()),
  } as unknown as EvaluationService;
  return new TranscriptsService(prisma as unknown as PrismaService, evalSheets, evaluationService);
}

function buildRequest(rawText: string): CreateTranscriptRequest {
  return { domainId: 'telecom', rawText };
}

describe('TranscriptsService — FR-4 maskingSummary 저장/조회 왕복', () => {
  test('PII(전화번호)가 포함된 rawText는 counts가 정확히 반영된 maskingSummary로 저장·조회된다', async () => {
    const prisma = createFakePrisma();
    const service = createService(prisma);

    const { transcriptId } = await service.createAndEvaluate(
      buildRequest('상담사: 연락처는 010-1234-5678 입니다. 확인 부탁드립니다.'),
    );

    const result = await service.getResult(transcriptId);

    expect(result.maskingSummary).toEqual({ rrn: 0, phone: 1, card: 0, account: 0, email: 0 });
  });

  test('PII가 없는 rawText는 5종 모두 0인 maskingSummary로 저장·조회된다', async () => {
    const prisma = createFakePrisma();
    const service = createService(prisma);

    const { transcriptId } = await service.createAndEvaluate(
      buildRequest('상담사: 안녕하세요 고객님 무엇을 도와드릴까요?'),
    );

    const result = await service.getResult(transcriptId);

    expect(result.maskingSummary).toEqual({ rrn: 0, phone: 0, card: 0, account: 0, email: 0 });
  });

  test('저장된 maskedText에는 원문 PII 패턴이 남아있지 않다(Phase 1 AC-6 유지 확인)', async () => {
    const prisma = createFakePrisma();
    const service = createService(prisma);

    const { transcriptId } = await service.createAndEvaluate(
      buildRequest('상담사: 연락처는 010-1234-5678 입니다.'),
    );

    const stored = prisma.__transcripts.get(transcriptId);
    expect(stored?.maskedText).not.toContain('010-1234-5678');
    expect(stored?.maskedText).toContain('[전화번호]');
  });

  test('getResultByEvaluationId 경로로 조회해도 동일한 maskingSummary가 내려온다', async () => {
    const prisma = createFakePrisma();
    const service = createService(prisma);

    const { transcriptId, evaluationId } = await service.createAndEvaluate(
      buildRequest('고객: 이메일은 test@example.com 입니다.'),
    );

    const byTranscript = await service.getResult(transcriptId);
    const byEvaluation = await service.getResultByEvaluationId(evaluationId);

    expect(byEvaluation.maskingSummary).toEqual(byTranscript.maskingSummary);
    expect(byEvaluation.maskingSummary).toEqual({ rrn: 0, phone: 0, card: 0, account: 0, email: 1 });
  });
});

describe('TranscriptsService — L-4 parseMaskingSummary 방어(손상 값 방어, 500 미발생)', () => {
  test('maskingSummary 컬럼이 null(레거시 레코드)이면 조회 응답도 null이다', async () => {
    const prisma = createFakePrisma();
    const service = createService(prisma);

    const { transcriptId } = await service.createAndEvaluate(buildRequest('상담사: 안녕하세요 고객님.'));
    const stored = prisma.__transcripts.get(transcriptId)!;
    stored.maskingSummary = null; // Phase 3 이전 레코드 흉내(컬럼 자체가 없던 시절)

    const result = await service.getResult(transcriptId);
    expect(result.maskingSummary).toBeNull();
  });

  test('maskingSummary 컬럼 값이 손상된 JSON이어도 예외 없이 null로 방어된다(500 미발생)', async () => {
    const prisma = createFakePrisma();
    const service = createService(prisma);

    const { transcriptId } = await service.createAndEvaluate(buildRequest('상담사: 안녕하세요 고객님.'));
    const stored = prisma.__transcripts.get(transcriptId)!;
    stored.maskingSummary = '{invalid-json'; // 수동 DB 조작 등으로 인한 컬럼 손상 흉내

    const resultPromise = service.getResult(transcriptId);
    await expect(resultPromise).resolves.toBeDefined();

    const result = await resultPromise;
    expect(result.maskingSummary).toBeNull();
    // 나머지 필드는 정상적으로 채워져 있어야 한다(방어 로직이 응답 전체를 무너뜨리지 않음).
    expect(result.transcriptId).toBe(transcriptId);
  });
});
