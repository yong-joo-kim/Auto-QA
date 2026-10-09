import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as ExcelJS from 'exceljs';
import { listSupportedDomainIds } from '@auto-qa/eval-schema';
import { TranscriptsService } from './transcripts.service';
import { EvalSheetsService } from '../eval-sheets/eval-sheets.service';
import { buildEvalSheetWorkbook } from '../eval-sheets/eval-sheet-xlsx';
import { EvaluationService } from '../evaluation/evaluation.service';
import { MockLlmEvaluationProvider } from '../evaluation/llm/mock-llm-evaluation.provider';
import { LlmEvaluationRequest } from '../evaluation/llm/llm-evaluation-provider.interface';
import { PrismaService } from '../prisma/prisma.service';

/**
 * 통합 테스트: 업로드한 수정 시트가 실제 채점 경로
 * (TranscriptsService.createAndEvaluate -> EvaluationService -> MockLlmEvaluationProvider)에
 * 반영되어 수정된 항목명/배점으로 결과가 나오는지 검증한다. 실제 LLM 호출 없음.
 */

type Row = Record<string, unknown> & { id: string };

function createFakePrisma() {
  const transcripts = new Map<string, Row>();
  const evaluations = new Map<string, Row>();
  let seq = 0;
  return {
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
  };
}

describe('업로드한 수정 시트의 실제 채점 경로 반영(mock LLM)', () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'EVAL_SHEETS_OVERRIDE_DIR',
    'MOCK_LLM_MIN_LATENCY_MS',
    'MOCK_LLM_MAX_LATENCY_MS',
    'MOCK_LLM_FAILURE_RATE',
    'MOCK_LLM_FORCE_INVALID',
  ];
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalsheets-apply-'));
    process.env.EVAL_SHEETS_OVERRIDE_DIR = dir;
    process.env.MOCK_LLM_MIN_LATENCY_MS = '0';
    process.env.MOCK_LLM_MAX_LATENCY_MS = '0';
    delete process.env.MOCK_LLM_FAILURE_RATE;
    delete process.env.MOCK_LLM_FORCE_INVALID;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function setup() {
    const requests: LlmEvaluationRequest[] = [];
    const mock = new MockLlmEvaluationProvider();
    const provider = {
      evaluate: (req: LlmEvaluationRequest) => {
        requests.push(req);
        return mock.evaluate(req);
      },
    };
    const evalSheets = new EvalSheetsService();
    const service = new TranscriptsService(
      createFakePrisma() as unknown as PrismaService,
      evalSheets,
      new EvaluationService(provider as never),
    );
    return { evalSheets, service, requests };
  }

  async function uploadModified(evalSheets: EvalSheetsService, fn: (ws: ExcelJS.Worksheet) => void) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(
      (await buildEvalSheetWorkbook(listSupportedDomainIds().map((id) => evalSheets.getSheet(id)))) as unknown as ExcelJS.Buffer,
    );
    fn(wb.worksheets.find((w) => w.name.startsWith('3_'))!);
    return evalSheets.importWorkbook(Buffer.from(await wb.xlsx.writeBuffer()));
  }

  const RAW = '상담사: 안녕하세요 고객님 무엇을 도와드릴까요? 고객: 요금제 변경 문의드립니다.';

  test('업로드 후에는 수정된 항목명/배점으로 채점되고, 이전 결과는 당시 기준을 유지한다', async () => {
    const { evalSheets, service, requests } = setup();
    const first = await service.createAndEvaluate({ domainId: 'telecom', rawText: RAW });
    const before = await service.getResultByEvaluationId(first.evaluationId);

    await uploadModified(evalSheets, (ws) => {
      ws.getCell('B8').value = '수정된 첫 항목명';
      ws.getCell('D8').value = before.items[0].maxScore - 1;
      ws.getCell('D9').value = before.items[1].maxScore + 1;
    });

    const second = await service.createAndEvaluate({ domainId: 'telecom', rawText: RAW });
    const after = await service.getResultByEvaluationId(second.evaluationId);

    // LLM(mock)에 전달된 평가시트가 수정본이다.
    const sent = requests[requests.length - 1].evalSheet;
    expect(sent.categories[0].items[0].itemName).toBe('수정된 첫 항목명');
    expect(sent.version).not.toBe(before.evalSheetVersion);

    // 결과가 수정된 항목명/배점으로 나온다. 항목 수와 총점 만점은 유지된다.
    expect(after.items).toHaveLength(before.items.length);
    expect(after.items[0].itemName).toBe('수정된 첫 항목명');
    expect(after.items[1].itemId).toBe(before.items[1].itemId); // 이름을 바꾼 항목만 신규 itemId, 나머지는 유지
    expect(after.items[0].itemId).not.toBe(before.items[0].itemId);
    expect(after.items[0].maxScore).toBe(before.items[0].maxScore - 1);
    expect(after.items[1].maxScore).toBe(before.items[1].maxScore + 1);
    expect(after.evalSheetVersion).toBe(sent.version);
    expect(after.totalMaxScore).toBe(before.totalMaxScore);
    for (const item of after.items) {
      expect(item.score).toBeGreaterThanOrEqual(0);
      expect(item.score).toBeLessThanOrEqual(item.maxScore);
    }
    expect(after.totalScore).toBe(after.items.reduce((s, i) => s + i.score, 0));

    // 이전 결과는 당시 기준을 유지한다.
    const stillOld = await service.getResultByEvaluationId(first.evaluationId);
    expect(stillOld.items[0].itemName).toBe(before.items[0].itemName);
    expect(stillOld.items[0].maxScore).toBe(before.items[0].maxScore);
    expect(stillOld.evalSheetVersion).toBe(before.evalSheetVersion);
  });

  test('수정하지 않은 다른 도메인은 영향받지 않고, 기본값 복원 후에는 다시 seed 기준으로 채점된다', async () => {
    const { evalSheets, service, requests } = setup();
    const baseline = await service.createAndEvaluate({ domainId: 'telecom', rawText: RAW });
    const baseItems = (await service.getResultByEvaluationId(baseline.evaluationId)).items;

    await uploadModified(evalSheets, (ws) => {
      ws.getCell('B8').value = '수정된 첫 항목명';
    });
    const other = 'insurance' as const;
    const otherVersion = evalSheets.getSheet(other).version;
    await service.createAndEvaluate({ domainId: other, rawText: RAW });
    expect(requests[requests.length - 1].evalSheet.version).toBe(otherVersion);
    expect(evalSheets.list().find((s) => s.domainId === other)?.customized).toBe(false);

    await evalSheets.resetToDefault('telecom');
    const restored = await service.createAndEvaluate({ domainId: 'telecom', rawText: RAW });
    const restoredItems = (await service.getResultByEvaluationId(restored.evaluationId)).items;
    expect(restoredItems[0].itemName).toBe(baseItems[0].itemName);
    expect(restoredItems.map((i) => i.maxScore)).toEqual(baseItems.map((i) => i.maxScore));
  });
});
