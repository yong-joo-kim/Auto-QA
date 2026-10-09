import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as ExcelJS from 'exceljs';
import {
  EvalSheetOverrideCorruptError,
  listSupportedDomainIds,
  loadEvalSheet,
  loadSeedEvalSheet,
} from '@auto-qa/eval-schema';
import { buildEvalSheetWorkbook, inspectZip, parseEvalSheetWorkbook } from './eval-sheet-xlsx';
import { EvalSheetsService } from './eval-sheets.service';

/**
 * 회귀 테스트: docs/review/eval-sheet-upload-download-review.md
 * H-1(희소 대형 시트), M-1(zip bomb), M-2(버전 충돌), M-3(ID 재사용), M-4(원자적 쓰기/동시성),
 * M-6(손상 override), M-8(길이 상한).
 */

const domainIds = listSupportedDomainIds();
const seeds = domainIds.map((id) => loadSeedEvalSheet(id));
const loadSeed = (id: string) => loadSeedEvalSheet(id);

const exportSeedBuffer = () => buildEvalSheetWorkbook(seeds);

async function modify(base: Buffer, fn: (wb: ExcelJS.Workbook) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(base as unknown as ExcelJS.Buffer);
  fn(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const tab = (wb: ExcelJS.Workbook, prefix: string) => wb.worksheets.find((w) => w.name.startsWith(prefix))!;

function patchCentralDirectory(buf: Buffer, patch: (b: Buffer, eocd: number, firstEntry: number) => void): Buffer {
  const b = Buffer.from(buf);
  const eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  patch(b, eocd, b.readUInt32LE(eocd + 16));
  return b;
}

let dir: string;
const prevOverrideDir = process.env.EVAL_SHEETS_OVERRIDE_DIR;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalsheets-hardening-'));
  process.env.EVAL_SHEETS_OVERRIDE_DIR = dir;
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
  if (prevOverrideDir === undefined) delete process.env.EVAL_SHEETS_OVERRIDE_DIR;
  else process.env.EVAL_SHEETS_OVERRIDE_DIR = prevOverrideDir;
});

describe('H-1 희소 대형 시트', () => {
  test('헤더만 있고 아주 먼 행에 셀 하나만 있는 탭도 빠르게 오류로 끝난다(메모리 폭주 없음)', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('3_통신');
    ['구분', '평가항목', '세부 평가내용', '배점', '게이팅(P/F)'].forEach((h, i) => {
      ws.getCell(7, i + 1).value = h;
    });
    ws.getCell(1048000, 1).value = 'x';
    const buf = Buffer.from(await wb.xlsx.writeBuffer());

    const heapBefore = process.memoryUsage().heapUsed;
    const started = Date.now();
    const result = await parseEvalSheetWorkbook(buf, domainIds, loadSeed);
    const elapsed = Date.now() - started;
    const heapGrowthMb = (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024;

    expect(result.errors.join('\n')).toContain('평가항목이 하나도 없습니다');
    expect(elapsed).toBeLessThan(3000);
    expect(heapGrowthMb).toBeLessThan(150);
  });

  test('시트(탭)가 20개를 넘으면 거부된다', async () => {
    const wb = new ExcelJS.Workbook();
    for (let i = 0; i < 21; i++) wb.addWorksheet(`메모${i}`);
    const result = await parseEvalSheetWorkbook(Buffer.from(await wb.xlsx.writeBuffer()), domainIds, loadSeed);
    expect(result.errors[0]).toContain('최대 20개');
  });
});

describe('M-1 zip 압축 해제 크기 상한', () => {
  test('선언된 압축 해제 크기 합계가 한도를 넘으면 로드 전에 거부된다', async () => {
    const valid = await exportSeedBuffer();
    expect(inspectZip(valid)).toBeUndefined();

    const bomb = patchCentralDirectory(valid, (b, _eocd, first) => b.writeUInt32LE(60 * 1024 * 1024, first + 24));
    const result = await parseEvalSheetWorkbook(bomb, domainIds, loadSeed);
    expect(result.errors[0]).toContain('허용 한도');
    expect(result.parsed).toEqual([]);
  });

  test('압축 항목 수가 비정상적으로 많으면 거부된다', async () => {
    const many = patchCentralDirectory(await exportSeedBuffer(), (b, eocd) => b.writeUInt16LE(500, eocd + 10));
    expect(inspectZip(many)).toContain('비정상');
  });

  test('zip이 아닌 데이터는 읽을 수 없는 파일로 처리된다', () => {
    expect(inspectZip(Buffer.from('plain text'))).toContain('읽을 수 없습니다');
  });
});

describe('M-2 버전 라벨 유일성', () => {
  test('복원 후 다른 내용으로 재업로드해도 이전 버전 라벨이 재사용되지 않는다', async () => {
    const service = new EvalSheetsService();
    const base = await exportSeedBuffer();

    const first = await service.importWorkbook(await modify(base, (wb) => { tab(wb, '3_').getCell('B8').value = 'A안'; }));
    await service.resetToDefault('telecom');
    const second = await service.importWorkbook(await modify(base, (wb) => { tab(wb, '3_').getCell('B8').value = 'B안'; }));

    expect(first.updated[0].version).toMatch(/^1\.0\.1\+[0-9a-f]{8}$/);
    expect(second.updated[0].version).toMatch(/^1\.0\.2\+[0-9a-f]{8}$/);
    expect(second.updated[0].version).not.toBe(first.updated[0].version);
  });

  test('같은 기반에서 나온 서로 다른 내용은 patch가 같아도 해시로 구분된다', async () => {
    const base = await exportSeedBuffer();
    const a = await parseEvalSheetWorkbook(await modify(base, (wb) => { tab(wb, '3_').getCell('B8').value = 'A안'; }), domainIds, loadSeed);
    const b = await parseEvalSheetWorkbook(await modify(base, (wb) => { tab(wb, '3_').getCell('B8').value = 'B안'; }), domainIds, loadSeed);
    const va = a.parsed.find((p) => p.domainId === 'telecom')!.sheet.version;
    const vb = b.parsed.find((p) => p.domainId === 'telecom')!.sheet.version;

    expect(va.split('+')[0]).toBe(vb.split('+')[0]);
    expect(va).not.toBe(vb);
  });

  test('동시에 들어온 두 업로드는 직렬화되어 두 번째가 첫 번째 결과를 기반으로 반영된다', async () => {
    const service = new EvalSheetsService();
    const base = await exportSeedBuffer();
    const bufA = await modify(base, (wb) => { tab(wb, '3_').getCell('B8').value = 'A안'; });
    const bufB = await modify(base, (wb) => { tab(wb, '3_').getCell('B8').value = 'B안'; });

    const [a, b] = await Promise.all([service.importWorkbook(bufA), service.importWorkbook(bufB)]);

    expect(a.updated[0].version).toMatch(/^1\.0\.1\+/);
    expect(b.updated[0].version).toMatch(/^1\.0\.2\+/);
    expect(service.getSheet('telecom').categories[0].items[0].itemName).toBe('B안');
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

describe('M-3 itemId/categoryId 재사용 방지', () => {
  test('여러 번 업로드해도 삭제(교체)된 itemId가 다른 항목에 다시 발급되지 않는다', async () => {
    const service = new EvalSheetsService();
    const seedFirstItemId = loadSeedEvalSheet('telecom').categories[0].items[0].itemId;

    await service.importWorkbook(
      await modify(await exportSeedBuffer(), (wb) => { tab(wb, '3_').getCell('B8').value = '교체1'; }),
    );
    const afterFirst = service.getSheet('telecom').categories[0].items[0].itemId;
    await service.importWorkbook(
      await modify(await service.exportWorkbook(), (wb) => { tab(wb, '3_').getCell('B8').value = '교체2'; }),
    );
    const afterSecond = service.getSheet('telecom').categories[0].items[0].itemId;

    expect(afterFirst).not.toBe(seedFirstItemId);
    expect(afterSecond).not.toBe(seedFirstItemId);
    expect(afterSecond).not.toBe(afterFirst);
  });

  test('복원 후 신규 구분을 추가해도 과거에 발급된 categoryId를 재사용하지 않는다', async () => {
    const service = new EvalSheetsService();
    const base = await exportSeedBuffer();
    const addCategory = (name: string) =>
      modify(base, (wb) => {
        const ws = tab(wb, '3_');
        ws.getCell('A8').value = name;
        ws.getCell('A9').value = name;
      });

    await service.importWorkbook(await addCategory('신규구분1'));
    const firstId = service.getSheet('telecom').categories.find((c) => c.categoryName === '신규구분1')!.categoryId;
    await service.resetToDefault('telecom');
    await service.importWorkbook(await addCategory('신규구분2'));
    const secondId = service.getSheet('telecom').categories.find((c) => c.categoryName === '신규구분2')!.categoryId;

    expect(secondId).not.toBe(firstId);
  });
});

describe('M-4 원자적 쓰기', () => {
  test('중간 도메인 저장이 실패하면 이미 반영한 도메인도 롤백되고 임시 파일이 남지 않는다', async () => {
    const service = new EvalSheetsService();
    const buf = await modify(await exportSeedBuffer(), (wb) => {
      tab(wb, '1_').getCell('B8').value = '수정1';
      tab(wb, '2_').getCell('B8').value = '수정2';
      tab(wb, '3_').getCell('B8').value = '수정3';
    });

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const realFs = require('fs') as typeof fs;
    const original = realFs.renameSync.bind(realFs);
    jest.spyOn(realFs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith(`${path.sep}telecom.json`)) throw new Error('EPERM 시뮬레이션');
      return original(from, to);
    });

    await expect(service.importWorkbook(buf)).rejects.toThrow('EPERM');
    jest.restoreAllMocks();

    expect(service.list().every((s) => !s.customized)).toBe(true);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    // 실패 후에도 정상 재시도가 가능하다.
    await expect(service.importWorkbook(buf)).resolves.toMatchObject({ updated: expect.any(Array) });
    expect(service.list().filter((s) => s.customized)).toHaveLength(3);
  });

  test('이미 override가 있던 도메인은 롤백 시 이전 내용으로 복구된다', async () => {
    const service = new EvalSheetsService();
    await service.importWorkbook(
      await modify(await exportSeedBuffer(), (wb) => { tab(wb, '1_').getCell('B8').value = '기존 수정'; }),
    );
    const before = fs.readFileSync(path.join(dir, 'finance-banking-card.json'), 'utf-8');

    const buf = await modify(await service.exportWorkbook(), (wb) => {
      tab(wb, '1_').getCell('B8').value = '새 수정';
      tab(wb, '3_').getCell('B8').value = '수정3';
    });
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const realFs = require('fs') as typeof fs;
    const original = realFs.renameSync.bind(realFs);
    jest.spyOn(realFs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith(`${path.sep}telecom.json`)) throw new Error('EBUSY 시뮬레이션');
      return original(from, to);
    });

    await expect(service.importWorkbook(buf)).rejects.toThrow('EBUSY');
    jest.restoreAllMocks();

    expect(fs.readFileSync(path.join(dir, 'finance-banking-card.json'), 'utf-8')).toBe(before);
  });
});

describe('M-6 손상된 override 파일', () => {
  const corrupt = () => fs.writeFileSync(path.join(dir, 'telecom.json'), '{broken json', 'utf-8');

  test('loadEvalSheet는 미지원 domainId 오류와 구분되는 전용 오류를 던진다', () => {
    corrupt();
    expect(() => loadEvalSheet('telecom')).toThrow(EvalSheetOverrideCorruptError);
    expect(() => loadEvalSheet('no-such-domain')).toThrow(/지원하지 않는 domainId/);
    expect(() => loadEvalSheet('no-such-domain')).not.toThrow(EvalSheetOverrideCorruptError);
  });

  test('스키마 검증에 실패하는 override도 손상으로 취급된다', () => {
    fs.writeFileSync(path.join(dir, 'telecom.json'), JSON.stringify({ ...loadSeedEvalSheet('telecom'), totalMaxScore: 1 }), 'utf-8');
    expect(() => loadEvalSheet('telecom')).toThrow(EvalSheetOverrideCorruptError);
  });

  test('list()는 손상된 도메인만 corrupted로 표시하고 전체가 실패하지 않는다', () => {
    corrupt();
    const list = new EvalSheetsService().list();
    expect(list).toHaveLength(10);
    expect(list.find((s) => s.domainId === 'telecom')).toMatchObject({ corrupted: true, customized: true });
    expect(list.filter((s) => s.corrupted)).toHaveLength(1);
  });

  test('다운로드는 원인을 알 수 있는 오류를 반환하고, 복원 또는 재업로드로 복구된다', async () => {
    const service = new EvalSheetsService();
    corrupt();
    expect(() => service.exportWorkbook()).toThrow(/손상/);

    // 재업로드(seed 기반)로 복구
    const res = await service.importWorkbook(await exportSeedBuffer());
    expect(res.updated.map((u) => u.domainId)).toEqual(['telecom']);
    expect(service.list().some((s) => s.corrupted)).toBe(false);

    // 복원으로도 복구
    corrupt();
    await service.resetToDefault('telecom');
    expect(service.getSheet('telecom')).toEqual(loadSeedEvalSheet('telecom'));
  });
});

describe('M-8 길이 상한', () => {
  test.each([
    ['세부 평가내용 1001자', (ws: ExcelJS.Worksheet) => { ws.getCell('C8').value = 'x'.repeat(1001); }, '1000자'],
    ['평가항목명 101자', (ws: ExcelJS.Worksheet) => { ws.getCell('B8').value = 'x'.repeat(101); }, '100자'],
    ['출처 문구 501자', (ws: ExcelJS.Worksheet) => {
      ws.eachRow((row) => {
        if (String(row.getCell(1).value ?? '').startsWith('출처')) row.getCell(1).value = `출처 ${'x'.repeat(500)}`;
      });
    }, '500자'],
  ])('%s는 거부된다', async (_n, mutate, expected) => {
    const buf = await modify(await exportSeedBuffer(), (wb) => mutate(tab(wb, '3_')));
    const result = await parseEvalSheetWorkbook(buf, domainIds, loadSeed);
    expect(result.errors.join('\n')).toContain(expected);
    expect(result.parsed.find((p) => p.domainId === 'telecom')).toBeUndefined();
  });

  test('경계값(1000자)은 허용된다', async () => {
    const buf = await modify(await exportSeedBuffer(), (wb) => { tab(wb, '3_').getCell('C8').value = 'x'.repeat(1000); });
    const result = await parseEvalSheetWorkbook(buf, domainIds, loadSeed);
    expect(result.errors).toEqual([]);
  });
});
