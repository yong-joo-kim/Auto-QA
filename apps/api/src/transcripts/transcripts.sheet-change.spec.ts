import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as ExcelJS from 'exceljs';
import { listSupportedDomainIds, loadSeedEvalSheet } from '@auto-qa/eval-schema';
import { TranscriptsService } from './transcripts.service';
import { EvalSheetsService } from '../eval-sheets/eval-sheets.service';
import { buildEvalSheetWorkbook } from '../eval-sheets/eval-sheet-xlsx';
import {
  aggregateFromScoredItems,
  AggregatedEvaluation,
  EvaluationService,
} from '../evaluation/evaluation.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 회귀 테스트: 평가시트 수정 이후 과거 결과의 점수 보정/조회(H-2, L-5)와 손상 override(M-6).
 * 참고: docs/review/eval-sheet-upload-download-review.md
 */

type Row = Record<string, unknown> & { id: string };

function createFakePrisma() {
  const transcripts = new Map<string, Row>();
  const evaluations = new Map<string, Row>();
  let seq = 0;
  const prisma = {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        transcript: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            const row = { id: `t-${++seq}`, ...data } as Row;
            transcripts.set(row.id, row);
            return row;
          },
        },
        evaluation: {
          create: async ({ data }: { data: Record<string, unknown> }) => {
            const row = { id: `e-${++seq}`, createdAt: new Date('2026-10-09T00:00:00Z'), ...data } as Row;
            evaluations.set(row.id, row);
            return row;
          },
        },
      }),
    transcript: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const t = transcripts.get(where.id);
        if (!t) return null;
        return { ...t, evaluation: [...evaluations.values()].find((e) => e.transcriptId === t.id) ?? null };
      },
    },
    evaluation: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const e = evaluations.get(where.id);
        return e ? { ...e, transcript: transcripts.get(e.transcriptId as string) ?? null } : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        Object.assign(evaluations.get(where.id)!, data);
      },
    },
    __evaluations: evaluations,
  };
  return prisma;
}

describe('평가시트 수정 이후 과거 결과 보정/조회', () => {
  let dir: string;
  const prev = process.env.EVAL_SHEETS_OVERRIDE_DIR;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalsheets-tx-'));
    process.env.EVAL_SHEETS_OVERRIDE_DIR = dir;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.EVAL_SHEETS_OVERRIDE_DIR;
    else process.env.EVAL_SHEETS_OVERRIDE_DIR = prev;
  });

  function setup() {
    const prisma = createFakePrisma();
    const evalSheets = new EvalSheetsService();
    const evaluationService = {
      // 현재(채점 시점) 시트의 모든 항목에 만점을 부여한 결과를 돌려준다.
      evaluateAndAggregate: jest.fn(async (_d: string, _t: string, sheet: ReturnType<EvalSheetsService['getSheet']>) => {
        const scored = sheet.categories.flatMap((c) =>
          c.items.map((i) => ({ itemId: i.itemId, score: i.maxScore, reason: '사유', passFail: i.gating ? ('P' as const) : undefined })),
        );
        return {
          ...aggregateFromScoredItems(scored, sheet),
          status: 'completed',
          goodPoints: [],
          improvements: [],
          profanityDetected: false,
          profanityMatches: [],
          piiDetected: false,
          piiMatches: [],
          llmProviderMeta: { provider: 'mock', model: 'mock-v1', latencyMs: 1 },
        } as unknown as AggregatedEvaluation;
      }),
    } as unknown as EvaluationService;
    const service = new TranscriptsService(prisma as unknown as PrismaService, evalSheets, evaluationService);
    return { prisma, evalSheets, service };
  }

  async function uploadModified(evalSheets: EvalSheetsService, fn: (ws: ExcelJS.Worksheet) => void) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await buildEvalSheetWorkbook(listSupportedDomainIds().map((id) => evalSheets.getSheet(id)))) as unknown as ExcelJS.Buffer);
    fn(wb.worksheets.find((w) => w.name.startsWith('3_'))!);
    return evalSheets.importWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
  }

  const RAW = '상담사: 안녕하세요 고객님 무엇을 도와드릴까요? 고객: 요금제 변경 문의드립니다.';

  test('H-2: 배점을 줄인 뒤 과거 결과를 보정해도 score<=maxScore, 항목 수·버전이 유지된다', async () => {
    const { evalSheets, service } = setup();
    const { evaluationId } = await service.createAndEvaluate({ domainId: 'telecom', rawText: RAW });
    const before = await service.getResultByEvaluationId(evaluationId);
    const target = before.items[0];

    // 시트 변경: 첫 항목 5 -> 4, 둘째 5 -> 6 (합계 100 유지)
    await uploadModified(evalSheets, (ws) => {
      ws.getCell('D8').value = target.maxScore - 1;
      ws.getCell('D9').value = before.items[1].maxScore + 1;
    });
    expect(evalSheets.getSheet('telecom').categories[0].items[0].maxScore).toBe(target.maxScore - 1);

    const after = await service.overrideItemScore(evaluationId, target.itemId, { score: target.maxScore });

    expect(after.items).toHaveLength(before.items.length);
    for (const item of after.items) expect(item.score).toBeLessThanOrEqual(item.maxScore);
    expect(after.items[0].maxScore).toBe(target.maxScore);
    expect(after.evalSheetVersion).toBe(before.evalSheetVersion);
    expect(after.totalScore).toBe(after.items.reduce((s, i) => s + i.score, 0));
    expect(after.totalMaxScore).toBe(before.totalMaxScore);
  });

  test('H-2: 항목명을 바꿔 itemId가 달라져도 502 없이 보정되고, 삭제/게이팅 변경도 과거 결과에 영향이 없다', async () => {
    const { evalSheets, service } = setup();
    const { evaluationId } = await service.createAndEvaluate({ domainId: 'telecom', rawText: RAW });
    const before = await service.getResultByEvaluationId(evaluationId);

    await uploadModified(evalSheets, (ws) => {
      ws.getCell('B8').value = '완전히 새 항목';
      ws.getCell('E9').value = ws.getCell('E9').value === 'P/F' ? '-' : 'P/F';
    });

    const after = await service.overrideItemScore(evaluationId, before.items[0].itemId, { score: 0 });

    expect(after.items.map((i) => i.itemId)).toEqual(before.items.map((i) => i.itemId));
    expect(after.items[0].itemName).toBe(before.items[0].itemName);
    expect(after.items[1].gating).toBe(before.items[1].gating);
    expect(after.items[0].score).toBe(0);
    expect(after.items[0].originalScore).toBe(before.items[0].score);
  });

  test('L-5: 시트 수정 후에도 과거 결과의 출처/도메인명은 채점 시점 값이다', async () => {
    const { evalSheets, service } = setup();
    const { evaluationId } = await service.createAndEvaluate({ domainId: 'telecom', rawText: RAW });
    const before = await service.getResultByEvaluationId(evaluationId);

    await uploadModified(evalSheets, (ws) => {
      ws.eachRow((row) => {
        if (String(row.getCell(1).value ?? '').startsWith('출처')) row.getCell(1).value = '출처: 변경된 문구';
      });
    });
    expect(evalSheets.getSheet('telecom').sourceCitation).toBe('출처: 변경된 문구');

    const after = await service.getResultByEvaluationId(evaluationId);
    expect(after.sourceCitation).toBe(before.sourceCitation);
    expect(after.evalSheetVersion).toBe(before.evalSheetVersion);
  });

  test('레거시 레코드(스냅샷 없음)도 버전이 달라졌다면 저장된 항목 기준으로 보정된다', async () => {
    const { prisma, evalSheets, service } = setup();
    const { evaluationId } = await service.createAndEvaluate({ domainId: 'telecom', rawText: RAW });
    const row = prisma.__evaluations.get(evaluationId)!;
    row.evalSheetSnapshot = null; // 스냅샷 도입 이전 레코드
    const before = await service.getResultByEvaluationId(evaluationId);

    await uploadModified(evalSheets, (ws) => {
      ws.getCell('B8').value = '완전히 새 항목';
      ws.getCell('D8').value = before.items[0].maxScore - 1;
      ws.getCell('D9').value = before.items[1].maxScore + 1;
    });

    const after = await service.overrideItemScore(evaluationId, before.items[0].itemId, { score: before.items[0].maxScore });
    expect(after.items).toHaveLength(before.items.length);
    for (const item of after.items) expect(item.score).toBeLessThanOrEqual(item.maxScore);
  });

  test('레거시 레코드 + 버전 동일이면 기존 동작(현재 시트 사용)을 유지한다', async () => {
    const { prisma, service } = setup();
    const { evaluationId } = await service.createAndEvaluate({ domainId: 'telecom', rawText: RAW });
    prisma.__evaluations.get(evaluationId)!.evalSheetSnapshot = null;
    const before = await service.getResultByEvaluationId(evaluationId);

    const after = await service.overrideItemScore(evaluationId, before.items[0].itemId, { score: 1 });
    expect(after.items[0].score).toBe(1);
    expect(after.totalScore).toBe(before.totalScore - before.items[0].score + 1);
  });

  test('M-6: override 가 손상되면 채점은 400(미지원)이 아닌 503 으로 원인을 알리고, 과거 결과 조회는 계속 된다', async () => {
    const { evalSheets, service } = setup();
    const { evaluationId } = await service.createAndEvaluate({ domainId: 'telecom', rawText: RAW });
    fs.writeFileSync(path.join(dir, 'telecom.json'), '{broken', 'utf-8');

    await expect(service.createAndEvaluate({ domainId: 'telecom', rawText: RAW })).rejects.toMatchObject({
      status: 503,
      message: expect.stringContaining('손상'),
    });
    const result = await service.getResultByEvaluationId(evaluationId);
    expect(result.domainName).toBe(loadSeedEvalSheet('telecom').domainName);
    expect(evalSheets.list().find((s) => s.domainId === 'telecom')?.corrupted).toBe(true);
  });

  test('M-6: 레거시 레코드 조회도 override 손상 시 seed 로 대체되어 500 이 나지 않는다', async () => {
    const { prisma, service } = setup();
    const { evaluationId } = await service.createAndEvaluate({ domainId: 'telecom', rawText: RAW });
    prisma.__evaluations.get(evaluationId)!.evalSheetSnapshot = null;
    fs.writeFileSync(path.join(dir, 'telecom.json'), '{broken', 'utf-8');

    await expect(service.getResultByEvaluationId(evaluationId)).resolves.toMatchObject({ id: evaluationId });
  });
});
