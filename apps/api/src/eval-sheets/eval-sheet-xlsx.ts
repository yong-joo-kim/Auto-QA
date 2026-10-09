import { createHash } from 'crypto';
import * as ExcelJS from 'exceljs';
import {
  EvalSheet,
  evalSheetSchema,
  MAX_CRITERIA_LENGTH,
  MAX_META_LENGTH,
  MAX_NAME_LENGTH,
} from '@auto-qa/eval-schema';

/**
 * 평가시트 Excel(`3. 도메인별_상담사_평가시트_10종.xlsx` 레이아웃) 입출력.
 *
 * 시트 구성: `00_안내` + 도메인별 `<번호>_<도메인명>` 탭(번호 1~10 = 도메인 순서).
 * 도메인 탭 레이아웃(1-indexed):
 *   1행 제목 / 2행 "주요 상담 유형: ..." / 4~5행 상담 메타 / 7행 헤더
 *   헤더: 구분 | 평가항목 | 세부 평가내용 | 배점 | 게이팅(P/F) | 획득점수 | 비고
 *   이후 항목 행 → 빈 행 → "합계" 행 → ... → "출처(...)" 행
 * 채점 입력 칸(획득점수 등)은 업로드 시 무시하며, 구분/평가항목/세부 평가내용/배점/게이팅만 읽는다.
 */

const SOURCE_PREFIX = '출처';
const TYPES_PREFIX = '주요 상담 유형:';
const REQUIRED_TOTAL = 100;

/** 도메인당 배점 합계 100, 항목 최소 1점이므로 항목은 최대 100개(H-1). */
const MAX_ITEMS_PER_DOMAIN = 100;
/** 헤더 아래로 읽는 최대 행 수. 희소 행(멀리 떨어진 셀)으로 인한 순회 폭주를 막는다(H-1). */
const MAX_SCAN_ROWS = 300;
/** 표 종료 지점 이후 출처 문구를 찾는 최대 행 수. */
const META_TAIL_ROWS = 30;
const MAX_WORKSHEETS = 20;
/** zip 압축 해제 상한(M-1). */
const MAX_ZIP_ENTRIES = 200;
const MAX_ZIP_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;

/** 도메인별 개정 이력: 버전 단조 증가(M-2)와 ID 재사용 방지(M-3)에 사용. */
export interface DomainHistoryInfo {
  maxPatch: number;
  usedItemIds: string[];
  usedCategoryIds: string[];
}
export type HistoryProvider = (domainId: string) => DomainHistoryInfo;
const NO_HISTORY: HistoryProvider = () => ({ maxPatch: 0, usedItemIds: [], usedCategoryIds: [] });

const UNREADABLE_MESSAGE = '엑셀(.xlsx) 파일을 읽을 수 없습니다. 파일이 손상되었거나 형식이 올바르지 않습니다.';

/**
 * zip 중앙 디렉터리만 읽어 엔트리 수/선언된 압축 해제 크기 합계를 검사한다(M-1).
 * JSZip은 해제 후 실제 크기가 선언값과 다르면 오류를 내므로, 선언값 검사로 zip bomb을 로드 전에 차단할 수 있다.
 * 문제가 없으면 undefined, 있으면 사용자용 오류 메시지를 반환한다.
 */
export function inspectZip(buffer: Buffer): string | undefined {
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) return UNREADABLE_MESSAGE;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return UNREADABLE_MESSAGE;
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (entryCount === 0xffff || offset === 0xffffffff) return UNREADABLE_MESSAGE; // zip64 미지원
  if (entryCount > MAX_ZIP_ENTRIES) return `파일 구조가 비정상입니다(압축 항목 ${entryCount}개 > ${MAX_ZIP_ENTRIES}개).`;
  let total = 0;
  for (let n = 0; n < entryCount; n++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) return UNREADABLE_MESSAGE;
    const size = buffer.readUInt32LE(offset + 24);
    if (size === 0xffffffff) return UNREADABLE_MESSAGE;
    total += size;
    if (total > MAX_ZIP_UNCOMPRESSED_BYTES) {
      return `압축을 푼 크기가 허용 한도(${MAX_ZIP_UNCOMPRESSED_BYTES / 1024 / 1024}MB)를 초과합니다.`;
    }
    offset += 46 + buffer.readUInt16LE(offset + 28) + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
  }
  return undefined;
}

export interface ParsedDomainSheet {
  domainId: string;
  sheetName: string;
  sheet: EvalSheet;
}

export interface ParseResult {
  parsed: ParsedDomainSheet[];
  /** 도메인 탭으로 인식되지 않아 무시된 시트 이름 */
  ignoredSheets: string[];
  /** 사용자에게 보여줄 검증 오류(하나라도 있으면 전체 반영 중단) */
  errors: string[];
}

function cellText(cell: ExcelJS.Cell | undefined): string {
  if (!cell) return '';
  const v = cell.value;
  if (v === null || v === undefined) return '';
  let text: string;
  if (typeof v === 'object') {
    if ('richText' in v) text = v.richText.map((r) => r.text).join('');
    else if ('result' in v) text = String(v.result ?? '');
    else if ('text' in v) text = String(v.text ?? '');
    else return '';
  } else {
    text = String(v);
  }
  // 셀 타입과 무관하게 개행 정규화(L-4)
  return text.replace(/\r?\n/g, ' ').trim();
}

function cellNumber(cell: ExcelJS.Cell | undefined): number {
  if (!cell) return NaN;
  const v = cell.value;
  const raw = typeof v === 'object' && v !== null && 'result' in v ? v.result : v;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string' && raw.trim() !== '') return Number(raw.trim());
  return NaN;
}

/** 탭 이름 앞 숫자(`3_통신...` → 3)를 도메인 순번으로 해석. 숫자 접두가 없으면 undefined. */
function sheetOrdinal(sheetName: string): number | undefined {
  const m = /^\s*(\d+)\s*_/.exec(sheetName);
  return m ? Number(m[1]) : undefined;
}

/**
 * 새 버전 문자열: `<major>.<minor>.<patch+1>+<내용해시 8자리>`.
 * patch는 현재 버전과 이력 최대값 중 큰 쪽에서 증가시켜 복원 후 재업로드해도 같은 번호가 나오지 않게 하고(M-2),
 * 내용 해시를 붙여 동시 업로드로 patch가 같아져도 서로 다른 기준은 서로 다른 버전으로 식별되게 한다.
 */
function nextVersion(baseVersion: string, historyMaxPatch: number, hash: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(baseVersion);
  if (!m) return `${baseVersion}-custom+${hash}`;
  return `${m[1]}.${m[2]}.${Math.max(Number(m[3]), historyMaxPatch) + 1}+${hash}`;
}

function contentHash(sheet: EvalSheet): string {
  return createHash('sha256')
    .update(JSON.stringify({ ...sheet, version: undefined }))
    .digest('hex')
    .slice(0, 8);
}

function parseDomainSheet(
  ws: ExcelJS.Worksheet,
  base: EvalSheet,
  history: DomainHistoryInfo,
  errors: string[],
): EvalSheet | undefined {
  const label = `[${ws.name}]`;
  const startErrors = errors.length;

  let headerRow = -1;
  // getRow는 없는 행을 생성해 워크시트에 유지하므로 findRow만 사용한다(H-1).
  for (let r = 1; r <= 30; r++) {
    const hr = ws.findRow(r);
    if (hr && cellText(hr.getCell(1)) === '구분' && cellText(hr.getCell(2)) === '평가항목') {
      headerRow = r;
      break;
    }
  }
  if (headerRow < 0) {
    errors.push(`${label} 헤더 행('구분' | '평가항목' | ...)을 찾을 수 없습니다. 원본 양식을 유지해 주세요.`);
    return undefined;
  }

  // 기존 시트의 categoryName→categoryId, (categoryId,itemName)→itemId 를 유지해 id 안정성 확보
  const categoryIdByName = new Map(base.categories.map((c) => [c.categoryName, c.categoryId]));
  const itemIdByKey = new Map<string, string>();
  for (const c of base.categories) for (const i of c.items) itemIdByKey.set(`${c.categoryId}\u0000${i.itemName}`, i.itemId);
  // 이력에 있는 ID(과거에 발급되었다가 삭제된 것 포함)는 재사용하지 않는다(M-3).
  const usedCategoryIds = new Set([...categoryIdByName.values(), ...history.usedCategoryIds]);
  const usedItemIds = new Set<string>([
    ...base.categories.flatMap((c) => c.items.map((i) => i.itemId)),
    ...history.usedItemIds,
  ]);

  const categoryOrder: string[] = [];
  const categories = new Map<
    string,
    { categoryId: string; categoryName: string; items: EvalSheet['categories'][number]['items'] }
  >();
  const seenItemNames = new Set<string>();
  const assignedItemIds = new Set<string>();
  let catSeq = 0;
  let currentCategoryName = '';

  let itemCount = 0;
  let tableEnd = headerRow + MAX_SCAN_ROWS + 1;
  for (let r = headerRow + 1; r <= headerRow + MAX_SCAN_ROWS; r++) {
    const row = ws.findRow(r);
    const catCell = row ? cellText(row.getCell(1)) : '';
    const itemName = row ? cellText(row.getCell(2)) : '';
    if (catCell === '합계') {
      tableEnd = r;
      break;
    }
    if (!row || (!catCell && !itemName)) {
      // 빈 행: 항목 이후의 빈 행이면 표 종료
      if (categories.size > 0) {
        tableEnd = r;
        break;
      }
      continue;
    }
    if (itemCount >= MAX_ITEMS_PER_DOMAIN) {
      errors.push(`${label} 평가항목은 최대 ${MAX_ITEMS_PER_DOMAIN}개까지 입력할 수 있습니다.`);
      break;
    }
    itemCount += 1;
    // 병합된 구분 셀(아래 행이 비어 있음) 대응
    const categoryName = catCell || currentCategoryName;
    currentCategoryName = categoryName;
    const rowLabel = `${label} ${r}행`;

    if (!categoryName) {
      errors.push(`${rowLabel}: 구분(카테고리)이 비어 있습니다.`);
      continue;
    }
    if (!itemName) {
      errors.push(`${rowLabel}: 평가항목명이 비어 있습니다.`);
      continue;
    }
    if (categoryName.length > MAX_NAME_LENGTH || itemName.length > MAX_NAME_LENGTH) {
      errors.push(`${rowLabel}: 구분/평가항목명은 ${MAX_NAME_LENGTH}자 이하여야 합니다.`);
      continue;
    }
    const criteria = cellText(row.getCell(3));
    if (!criteria) {
      errors.push(`${rowLabel}(${itemName}): 세부 평가내용이 비어 있습니다.`);
      continue;
    }
    if (criteria.length > MAX_CRITERIA_LENGTH) {
      errors.push(`${rowLabel}(${itemName}): 세부 평가내용은 ${MAX_CRITERIA_LENGTH}자 이하여야 합니다(현재 ${criteria.length}자).`);
      continue;
    }
    const maxScore = cellNumber(row.getCell(4));
    if (!Number.isInteger(maxScore) || maxScore <= 0) {
      errors.push(`${rowLabel}(${itemName}): 배점은 1 이상의 정수여야 합니다.`);
      continue;
    }
    const gatingRaw = cellText(row.getCell(5)).toUpperCase().replace(/\s/g, '');
    let gating = false;
    if (gatingRaw === 'P/F' || gatingRaw === 'PF') gating = true;
    else if (gatingRaw !== '' && gatingRaw !== '-') {
      errors.push(`${rowLabel}(${itemName}): 게이팅 값은 'P/F' 또는 '-' 이어야 합니다(입력값: ${gatingRaw}).`);
      continue;
    }

    // 요구사항: 항목명 중복 금지는 도메인(탭) 전체 범위(L-2)
    if (seenItemNames.has(itemName)) {
      errors.push(`${rowLabel}: 평가항목명 '${itemName}'이 같은 시트 안에서 중복됩니다(구분이 달라도 항목명은 고유해야 합니다).`);
      continue;
    }
    seenItemNames.add(itemName);

    let category = categories.get(categoryName);
    if (!category) {
      let categoryId = categoryIdByName.get(categoryName);
      if (!categoryId) {
        do {
          catSeq += 1;
          categoryId = `custom-category-${String(catSeq).padStart(2, '0')}`;
        } while (usedCategoryIds.has(categoryId));
        usedCategoryIds.add(categoryId);
      }
      category = { categoryId, categoryName, items: [] };
      categories.set(categoryName, category);
      categoryOrder.push(categoryName);
    }

    // itemId: 같은 카테고리·같은 항목명이면 기존 id 유지, 아니면 신규 채번
    let itemId = itemIdByKey.get(`${category.categoryId}\u0000${itemName}`);
    if (!itemId || assignedItemIds.has(itemId)) {
      let n = category.items.length + 1;
      do {
        itemId = `${category.categoryId}-${String(n).padStart(2, '0')}`;
        n += 1;
      } while (usedItemIds.has(itemId) || assignedItemIds.has(itemId));
    }
    assignedItemIds.add(itemId);
    usedItemIds.add(itemId);

    category.items.push({ itemId, itemName, criteria, maxScore, gating });
  }

  if (categories.size === 0) {
    errors.push(`${label} 평가항목이 하나도 없습니다.`);
    return undefined;
  }

  // 표 중간 빈 행으로 종료된 경우, '합계' 행 전까지 항목처럼 보이는 행이 남아 있으면 오류(L-3)
  if (cellText(ws.findRow(tableEnd)?.getCell(1)) !== '합계') {
    for (let r = tableEnd + 1; r <= tableEnd + MAX_SCAN_ROWS; r++) {
      const tr = ws.findRow(r);
      if (!tr) continue;
      if (cellText(tr.getCell(1)) === '합계') break;
      const hasItemLike = [2, 3, 4, 5].some((c) => cellText(tr.getCell(c)) !== '' || !Number.isNaN(cellNumber(tr.getCell(c))));
      if (hasItemLike) {
        errors.push(`${label} ${r}행: 빈 행 아래의 항목은 인식되지 않습니다. 표 중간의 빈 행을 삭제해 주세요.`);
        break;
      }
    }
  }

  // 메타 문구(주요 상담 유형 / 출처)는 있으면 갱신, 없으면 기존 값 유지
  let mainConsultationTypes = base.mainConsultationTypes;
  let sourceCitation = base.sourceCitation;
  const metaRows = [
    ...Array.from({ length: headerRow - 1 }, (_, i) => i + 1),
    ...Array.from({ length: META_TAIL_ROWS }, (_, i) => tableEnd + i),
  ];
  for (const r of metaRows) {
    const metaRow = ws.findRow(r);
    const text = metaRow ? cellText(metaRow.getCell(1)) : '';
    if (r < headerRow && text.startsWith(TYPES_PREFIX)) {
      mainConsultationTypes = text.slice(TYPES_PREFIX.length).trim() || mainConsultationTypes;
    } else if (r > headerRow && text.startsWith(SOURCE_PREFIX)) {
      sourceCitation = text;
    }
  }
  if ((mainConsultationTypes?.length ?? 0) > MAX_META_LENGTH || (sourceCitation?.length ?? 0) > MAX_META_LENGTH) {
    errors.push(`${label} '주요 상담 유형'/'출처' 문구는 ${MAX_META_LENGTH}자 이하여야 합니다.`);
  }

  const builtCategories = categoryOrder.map((name) => {
    const c = categories.get(name)!;
    return {
      categoryId: c.categoryId,
      categoryName: c.categoryName,
      maxScore: c.items.reduce((sum, i) => sum + i.maxScore, 0),
      items: c.items,
    };
  });
  const totalMaxScore = builtCategories.reduce((sum, c) => sum + c.maxScore, 0);
  if (totalMaxScore !== REQUIRED_TOTAL) {
    errors.push(
      `${label} 배점 합계가 ${totalMaxScore}점입니다. 등급 기준이 100점 만점 기준이므로 합계를 ${REQUIRED_TOTAL}점으로 맞춰 주세요.`,
    );
  }
  if (errors.length > startErrors) return undefined;

  const candidate: EvalSheet = {
    ...base,
    version: base.version,
    mainConsultationTypes,
    sourceCitation,
    totalMaxScore,
    categories: builtCategories,
  };
  candidate.version = nextVersion(base.version, history.maxPatch, contentHash(candidate));
  const check = evalSheetSchema.safeParse(candidate);
  if (!check.success) {
    for (const issue of check.error.issues) errors.push(`${label} ${issue.message}`);
    return undefined;
  }
  return check.data;
}

/**
 * 업로드된 xlsx 버퍼를 파싱·검증한다. `loadCurrent(domainId)`는 현재 유효 평가시트(기반 메타/ID 유지용).
 * `domainIds`는 탭 번호(1~10)와 대응하는 도메인 순서.
 */
export async function parseEvalSheetWorkbook(
  buffer: Buffer,
  domainIds: string[],
  loadCurrent: (domainId: string) => EvalSheet,
  loadHistory: HistoryProvider = NO_HISTORY,
): Promise<ParseResult> {
  const zipProblem = inspectZip(buffer);
  if (zipProblem) return { parsed: [], ignoredSheets: [], errors: [zipProblem] };
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  } catch {
    return { parsed: [], ignoredSheets: [], errors: [UNREADABLE_MESSAGE] };
  }
  if (wb.worksheets.length > MAX_WORKSHEETS) {
    return {
      parsed: [],
      ignoredSheets: [],
      errors: [`시트(탭)는 최대 ${MAX_WORKSHEETS}개까지 허용됩니다(현재 ${wb.worksheets.length}개).`],
    };
  }

  const parsed: ParsedDomainSheet[] = [];
  const ignoredSheets: string[] = [];
  const errors: string[] = [];
  const seenDomains = new Set<string>();

  for (const ws of wb.worksheets) {
    const ordinal = sheetOrdinal(ws.name);
    const domainId = ordinal !== undefined ? domainIds[ordinal - 1] : undefined;
    if (!domainId) {
      ignoredSheets.push(ws.name);
      continue;
    }
    if (seenDomains.has(domainId)) {
      errors.push(`[${ws.name}] 같은 도메인 번호의 탭이 중복되어 있습니다.`);
      continue;
    }
    seenDomains.add(domainId);
    const sheet = parseDomainSheet(ws, loadCurrent(domainId), loadHistory(domainId), errors);
    if (sheet) parsed.push({ domainId, sheetName: ws.name, sheet });
  }

  if (seenDomains.size === 0 && errors.length === 0) {
    errors.push("도메인 평가시트 탭('1_금융...', '3_통신...' 형식)을 찾을 수 없습니다. 다운로드한 양식을 사용해 주세요.");
  }
  return { parsed, ignoredSheets, errors };
}

const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3864' } };
const INPUT_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
const THIN: Partial<ExcelJS.Borders> = {
  top: { style: 'thin' },
  left: { style: 'thin' },
  bottom: { style: 'thin' },
  right: { style: 'thin' },
};

/** 탭 이름(31자·금지문자 제한)을 `<번호>_<도메인명>` 형식으로 생성. */
function tabName(ordinal: number, domainName: string): string {
  return `${ordinal}_${domainName}`.replace(/[\\/?*[\]:]/g, '-').slice(0, 31);
}

/** 현재 유효 평가시트들로 원본 양식과 동일한 구조의 xlsx 버퍼를 생성한다. */
export async function buildEvalSheetWorkbook(sheets: EvalSheet[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();

  const guide = wb.addWorksheet('00_안내');
  guide.getColumn(1).width = 120;
  [
    '도메인별 상담사 평가시트 (10종)',
    '■ 사용 방법',
    '1) 각 도메인 탭에서 구분 / 평가항목 / 세부 평가내용 / 배점 / 게이팅(P/F) 열을 수정하거나 행을 추가·삭제할 수 있습니다.',
    "2) 게이팅 항목은 'P/F', 일반 항목은 '-' 로 입력하세요.",
    '3) 도메인별 배점 합계는 반드시 100점이어야 합니다.',
    '4) 수정한 파일을 Auto QA 화면의 [평가시트 업로드]로 올리면 이후 채점부터 수정된 기준이 적용됩니다.',
    "5) 탭 이름 앞의 번호('1_', '2_' ...)는 도메인을 식별하므로 변경하지 마세요. 헤더 행과 열 순서도 유지해야 합니다.",
    '6) 획득점수·비고 열과 상담사 정보 칸은 업로드 시 사용되지 않습니다.',
  ].forEach((line, i) => {
    const cell = guide.getCell(i + 1, 1);
    cell.value = line;
    if (i === 0) cell.font = { bold: true, size: 14 };
    else if (line.startsWith('■')) cell.font = { bold: true };
  });

  sheets.forEach((sheet, idx) => {
    const ws = wb.addWorksheet(tabName(idx + 1, sheet.domainName));
    ws.columns = [{ width: 14 }, { width: 38 }, { width: 70 }, { width: 8 }, { width: 11 }, { width: 10 }, { width: 14 }];

    ws.getCell('A1').value = `${sheet.domainName} 상담사 평가시트`;
    ws.getCell('A1').font = { bold: true, size: 14 };
    ws.getCell('A2').value = `${TYPES_PREFIX} ${sheet.mainConsultationTypes ?? ''}`.trimEnd();
    ws.getCell('A4').value = '상담사명';
    ws.getCell('C4').value = '사번';
    ws.getCell('E4').value = '평가일';
    ws.getCell('A5').value = '평가자';
    ws.getCell('C5').value = '콜ID/녹취ID';
    ws.getCell('E5').value = '상담유형';

    const headerRow = 7;
    ['구분', '평가항목', '세부 평가내용', '배점', '게이팅(P/F)', '획득점수', '비고'].forEach((h, c) => {
      const cell = ws.getCell(headerRow, c + 1);
      cell.value = h;
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = HEADER_FILL;
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = THIN;
    });

    let r = headerRow + 1;
    const first = r;
    for (const category of sheet.categories) {
      for (const item of category.items) {
        const values = [category.categoryName, item.itemName, item.criteria, item.maxScore, item.gating ? 'P/F' : '-', null, null];
        values.forEach((v, c) => {
          const cell = ws.getCell(r, c + 1);
          cell.value = v;
          cell.border = THIN;
          cell.alignment = { vertical: 'middle', wrapText: c === 2, horizontal: c >= 3 && c <= 4 ? 'center' : 'left' };
          if (c === 5) cell.fill = INPUT_FILL;
        });
        r += 1;
      }
    }
    const last = r - 1;
    r += 1; // 빈 행
    ws.getCell(r, 1).value = '합계';
    ws.getCell(r, 4).value = { formula: `SUM(D${first}:D${last})`, result: sheet.totalMaxScore };
    ws.getCell(r, 6).value = { formula: `SUM(F${first}:F${last})`, result: 0 };
    for (let c = 1; c <= 7; c++) {
      ws.getCell(r, c).font = { bold: true };
      ws.getCell(r, c).border = THIN;
    }
    r += 2;
    if (sheet.sourceCitation) ws.getCell(r++, 1).value = sheet.sourceCitation;
    if (sheet.disclaimer) ws.getCell(r++, 1).value = sheet.disclaimer;
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}
