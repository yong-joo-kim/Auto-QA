import * as ExcelJS from 'exceljs';
import { listSupportedDomainIds, loadSeedEvalSheet } from '@auto-qa/eval-schema';
import { buildEvalSheetWorkbook, parseEvalSheetWorkbook } from './eval-sheet-xlsx';

/** 회귀 테스트: 리뷰 L-2(항목명 중복은 시트 전체 범위), L-3(표 중간 빈 행 아래 항목). */
const domainIds = listSupportedDomainIds();
const seeds = domainIds.map((id) => loadSeedEvalSheet(id));
const loadSeed = (id: string) => loadSeedEvalSheet(id);

async function modified(fn: (ws: ExcelJS.Worksheet) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await buildEvalSheetWorkbook(seeds)) as unknown as ExcelJS.Buffer);
  fn(wb.worksheets.find((w) => w.name.startsWith('3_'))!);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('L-2 항목명 중복(시트 전체)', () => {
  test('서로 다른 구분에 같은 항목명이 있으면 오류', async () => {
    const buf = await modified((ws) => {
      // 8행(첫 항목)과 마지막 항목의 구분이 다르다고 가정하고, 마지막 항목명을 첫 항목명으로 변경
      let last = 8;
      while (ws.getCell(last + 1, 2).value) last++;
      expect(ws.getCell(last, 1).value ?? ws.getCell(8, 1).value).toBeTruthy();
      ws.getCell(last, 2).value = ws.getCell(8, 2).value;
      ws.getCell(last, 1).value = '다른구분';
    });
    const r = await parseEvalSheetWorkbook(buf, domainIds, loadSeed);
    expect(r.errors.join('\n')).toContain('중복');
  });

  test('수정 없는 export 파일은 통과', async () => {
    const buf = await buildEvalSheetWorkbook(seeds);
    const r = await parseEvalSheetWorkbook(buf, domainIds, loadSeed);
    expect(r.errors).toEqual([]);
  });
});

describe('L-3 표 중간 빈 행', () => {
  test('빈 행 아래 항목이 있으면 행 번호가 포함된 오류', async () => {
    let target = 0;
    const buf = await modified((ws) => {
      target = 10;
      ws.spliceRows(target, 0, []); // 10행에 빈 행 삽입
    });
    const r = await parseEvalSheetWorkbook(buf, domainIds, loadSeed);
    const msg = r.errors.join('\n');
    expect(msg).toContain('빈 행 아래의 항목은 인식되지 않습니다');
    expect(msg).toContain(`${target + 1}행`);
  });

  test('정상 양식(항목 - 빈 행 - 합계 - 출처)은 오류 없음', async () => {
    const r = await parseEvalSheetWorkbook(await buildEvalSheetWorkbook(seeds), domainIds, loadSeed);
    expect(r.errors).toEqual([]);
  });
});
