import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as ExcelJS from 'exceljs';
import { listSupportedDomainIds, loadSeedEvalSheet } from '@auto-qa/eval-schema';
import { buildEvalSheetWorkbook, parseEvalSheetWorkbook } from './eval-sheet-xlsx';
import { EvalSheetsService } from './eval-sheets.service';

const domainIds = listSupportedDomainIds();
const seeds = domainIds.map((id) => loadSeedEvalSheet(id));
const loadSeed = (id: string) => loadSeedEvalSheet(id);

async function exportBuffer(): Promise<Buffer> {
  return buildEvalSheetWorkbook(seeds);
}

async function modify(fn: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await exportBuffer()) as unknown as ExcelJS.Buffer);
  fn(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('평가시트 xlsx 입출력', () => {
  test('다운로드한 파일을 그대로 파싱하면 seed 10종과 동일한 기준이 복원된다(id 유지)', async () => {
    const result = await parseEvalSheetWorkbook(await exportBuffer(), domainIds, loadSeed);

    expect(result.errors).toEqual([]);
    expect(result.parsed).toHaveLength(10);
    expect(result.ignoredSheets).toEqual(['00_안내']);
    for (const { domainId, sheet } of result.parsed) {
      const seed = loadSeed(domainId);
      expect({ ...sheet, version: undefined }).toEqual({ ...seed, version: undefined });
    }
  });

  test('배점/기준 수정, 항목 추가가 반영되고 기존 항목 id는 유지된다', async () => {
    const buf = await modify((wb) => {
      const ws = wb.worksheets.find((w) => w.name.startsWith('3_'))!;
      ws.getCell('C8').value = '수정된 세부 기준';
      ws.getCell('D8').value = 4; // 5 -> 4
      ws.getCell('D9').value = 6; // 5 -> 6 (합계 100 유지)
      ws.getCell('E9').value = 'P/F';
    });
    const result = await parseEvalSheetWorkbook(buf, domainIds, loadSeed);

    expect(result.errors).toEqual([]);
    const telecom = result.parsed.find((p) => p.domainId === 'telecom')!.sheet;
    const first = telecom.categories[0].items[0];
    expect(first.itemId).toBe('basic-response-01');
    expect(first.criteria).toBe('수정된 세부 기준');
    expect(first.maxScore).toBe(4);
    expect(telecom.categories[0].items[1]).toMatchObject({ itemId: 'basic-response-02', maxScore: 6, gating: true });
    expect(telecom.categories[0].maxScore).toBe(15);
    expect(telecom.totalMaxScore).toBe(100);
    expect(telecom.version).toMatch(/^1\.0\.1\+[0-9a-f]{8}$/);
  });

  test('항목명을 바꾸면 신규 itemId가 채번되고 신규 구분도 허용된다', async () => {
    const buf = await modify((wb) => {
      const ws = wb.worksheets.find((w) => w.name.startsWith('3_'))!;
      ws.getCell('B8').value = '완전히 새로운 항목';
      ws.getCell('A9').value = '신규구분';
      ws.getCell('D9').value = 5;
    });
    const result = await parseEvalSheetWorkbook(buf, domainIds, loadSeed);

    expect(result.errors).toEqual([]);
    const telecom = result.parsed.find((p) => p.domainId === 'telecom')!.sheet;
    const ids = telecom.categories.flatMap((c) => c.items.map((i) => i.itemId));
    expect(new Set(ids).size).toBe(ids.length);
    expect(telecom.categories[0].items[0].itemName).toBe('완전히 새로운 항목');
    expect(telecom.categories.some((c) => c.categoryName === '신규구분')).toBe(true);
  });

  test.each([
    ['배점 합계 != 100', (ws: ExcelJS.Worksheet) => { ws.getCell('D8').value = 9; }, '합계를 100점'],
    ['배점이 정수 아님', (ws: ExcelJS.Worksheet) => { ws.getCell('D8').value = 'abc'; }, '배점은 1 이상의 정수'],
    ['게이팅 값 오류', (ws: ExcelJS.Worksheet) => { ws.getCell('E8').value = 'X'; }, "'P/F' 또는 '-'"],
    ['세부 기준 누락', (ws: ExcelJS.Worksheet) => { ws.getCell('C8').value = null; }, '세부 평가내용이 비어'],
  ])('검증 오류: %s', async (_name, mutate, expected) => {
    const buf = await modify((wb) => mutate(wb.worksheets.find((w) => w.name.startsWith('3_'))!));
    const result = await parseEvalSheetWorkbook(buf, domainIds, loadSeed);

    expect(result.errors.join('\n')).toContain(expected);
  });

  test('xlsx가 아닌 파일은 오류로 거부된다', async () => {
    const result = await parseEvalSheetWorkbook(Buffer.from('not an excel'), domainIds, loadSeed);
    expect(result.errors[0]).toContain('읽을 수 없습니다');
  });
});

describe('EvalSheetsService 업로드 반영(override)', () => {
  let dir: string;
  const prev = process.env.EVAL_SHEETS_OVERRIDE_DIR;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalsheets-'));
    process.env.EVAL_SHEETS_OVERRIDE_DIR = dir;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.EVAL_SHEETS_OVERRIDE_DIR;
    else process.env.EVAL_SHEETS_OVERRIDE_DIR = prev;
  });

  test('변경 없는 파일은 아무것도 반영하지 않고, 수정한 도메인만 override되어 getSheet에 적용된다', async () => {
    const service = new EvalSheetsService();
    expect((await service.importWorkbook(await exportBuffer())).updated).toEqual([]);

    const buf = await modify((wb) => {
      const ws = wb.worksheets.find((w) => w.name.startsWith('3_'))!;
      ws.getCell('B8').value = '사용자 수정 항목';
    });
    const res = await service.importWorkbook(buf);

    expect(res.updated.map((u) => u.domainId)).toEqual(['telecom']);
    expect(service.getSheet('telecom').categories[0].items[0].itemName).toBe('사용자 수정 항목');
    expect(service.getSheet('insurance')).toEqual(loadSeed('insurance'));
    expect(service.list().find((s) => s.domainId === 'telecom')).toMatchObject({ customized: true, version: expect.stringMatching(/^1\.0\.1\+[0-9a-f]{8}$/) });

    // 다시 다운로드하면 수정본이 담기고, 초기화하면 seed로 복귀
    const reparsed = await parseEvalSheetWorkbook(await service.exportWorkbook(), domainIds, (id) => service.getSheet(id));
    expect(reparsed.parsed.find((p) => p.domainId === 'telecom')!.sheet.categories[0].items[0].itemName).toBe('사용자 수정 항목');
    await service.resetToDefault('telecom');
    expect(service.getSheet('telecom')).toEqual(loadSeed('telecom'));
  });

  test('오류가 있으면 all-or-nothing으로 하나도 반영되지 않는다', async () => {
    const service = new EvalSheetsService();
    const buf = await modify((wb) => {
      wb.worksheets.find((w) => w.name.startsWith('2_'))!.getCell('B8').value = '정상 수정';
      wb.worksheets.find((w) => w.name.startsWith('3_'))!.getCell('D8').value = 99;
    });

    await expect(service.importWorkbook(buf)).rejects.toThrow();
    expect(service.list().every((s) => !s.customized)).toBe(true);
  });
});
