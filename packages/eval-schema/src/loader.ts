import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { EvalSheet, evalSheetSchema } from './schema';

/**
 * seed/eval-sheets/*.json 로더.
 *
 * 모노레포 어디서 실행되든(apps/api dist, ts-node 등) 리포지토리 루트의
 * `seed/eval-sheets` 디렉터리를 찾아야 하므로, __dirname부터 상위 디렉터리로
 * 올라가며 `seed/eval-sheets`가 존재하는 첫 지점을 사용한다.
 * env `EVAL_SHEETS_DIR`로 강제 지정도 가능하다.
 */
function findSeedDir(): string {
  if (process.env.EVAL_SHEETS_DIR) {
    return process.env.EVAL_SHEETS_DIR;
  }
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'seed', 'eval-sheets');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    '평가시트 디렉터리(seed/eval-sheets)를 찾을 수 없습니다. EVAL_SHEETS_DIR 환경변수로 경로를 지정하세요.',
  );
}

const FILE_BY_DOMAIN: Record<string, string> = {
  'finance-banking-card': '01-finance-banking-card.json',
  insurance: '02-insurance.json',
  telecom: '03-telecom.json',
  'ecommerce-retail': '04-ecommerce-retail.json',
  'public-service': '05-public-service.json',
  healthcare: '06-healthcare.json',
  'it-support': '07-it-support.json',
  'travel-lodging': '08-travel-lodging.json',
  'delivery-o2o': '09-delivery-o2o.json',
  utility: '10-utility.json',
};

const cache = new Map<string, EvalSheet>();

/**
 * 사용자가 Excel 업로드로 수정한 평가시트(override) 저장 디렉터리.
 * env `EVAL_SHEETS_OVERRIDE_DIR`로 지정하며, 기본값은 리포지토리 루트의 `data/eval-sheets-override`.
 * override 파일이 있으면 seed보다 우선한다. (git 추적 제외: .gitignore의 /data/)
 */
function findOverrideDir(): string {
  if (process.env.EVAL_SHEETS_OVERRIDE_DIR) {
    return process.env.EVAL_SHEETS_OVERRIDE_DIR;
  }
  return path.join(path.dirname(path.dirname(findSeedDir())), 'data', 'eval-sheets-override');
}

function assertSupportedDomain(domainId: string): void {
  if (!Object.prototype.hasOwnProperty.call(FILE_BY_DOMAIN, domainId) || !/^[a-z0-9-]+$/.test(domainId)) {
    throw new Error(`지원하지 않는 domainId입니다: ${domainId}`);
  }
}

function overridePath(domainId: string): string {
  assertSupportedDomain(domainId);
  return path.join(findOverrideDir(), `${domainId}.json`);
}

function historyPath(domainId: string): string {
  assertSupportedDomain(domainId);
  return path.join(findOverrideDir(), `${domainId}.history.json`);
}

/** override 파일이 손상되었거나(JSON 파싱 실패) 스키마 검증에 실패한 경우. 미지원 domainId 오류와 구분하기 위한 전용 타입. */
export class EvalSheetOverrideCorruptError extends Error {
  constructor(
    public readonly domainId: string,
    cause?: unknown,
  ) {
    super(
      `수정된 평가시트 파일이 손상되었습니다(domainId=${domainId}). 평가시트 관리 화면에서 기본 평가시트로 복원하거나 올바른 파일을 다시 업로드해 주세요.`,
    );
    this.name = 'EvalSheetOverrideCorruptError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/** override 파일이 존재하면 zod 검증 후 반환한다(매 호출 디스크 조회 — 파일이 작고 호출 빈도가 낮다). */
function readOverride(domainId: string): EvalSheet | undefined {
  const file = overridePath(domainId);
  if (!fs.existsSync(file)) return undefined;
  try {
    return evalSheetSchema.parse(JSON.parse(fs.readFileSync(file, 'utf-8')));
  } catch (e) {
    throw new EvalSheetOverrideCorruptError(domainId, e);
  }
}

export function hasEvalSheetOverride(domainId: string): boolean {
  return fs.existsSync(overridePath(domainId));
}

/** override 파일의 최종 수정 시각(없으면 undefined). */
export function getEvalSheetOverrideUpdatedAt(domainId: string): Date | undefined {
  const file = overridePath(domainId);
  return fs.existsSync(file) ? fs.statSync(file).mtime : undefined;
}

/**
 * 도메인별 평가시트 개정 이력. override를 삭제(복원)해도 유지되어,
 *  - 버전 patch 번호가 단조 증가하고(M-2),
 *  - 한 번이라도 발급된 itemId/categoryId가 다른 항목에 재사용되지 않게 한다(M-3).
 */
export interface EvalSheetHistory {
  maxPatch: number;
  usedItemIds: string[];
  usedCategoryIds: string[];
}

export function readEvalSheetHistory(domainId: string): EvalSheetHistory {
  const empty: EvalSheetHistory = { maxPatch: 0, usedItemIds: [], usedCategoryIds: [] };
  const file = historyPath(domainId);
  if (!fs.existsSync(file)) return empty;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<EvalSheetHistory>;
    const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    return {
      maxPatch: typeof raw.maxPatch === 'number' && Number.isFinite(raw.maxPatch) ? raw.maxPatch : 0,
      usedItemIds: strings(raw.usedItemIds),
      usedCategoryIds: strings(raw.usedCategoryIds),
    };
  } catch {
    return empty; // 이력 파일 손상은 업로드를 막지 않는다(현재 시트의 ID로 최소 보호됨)
  }
}

function patchOf(version: string): number {
  const m = /^\d+\.\d+\.(\d+)/.exec(version);
  return m ? Number(m[1]) : 0;
}

function mergedHistory(sheet: EvalSheet): EvalSheetHistory {
  const prev = readEvalSheetHistory(sheet.domainId);
  return {
    maxPatch: Math.max(prev.maxPatch, patchOf(sheet.version)),
    usedItemIds: [...new Set([...prev.usedItemIds, ...sheet.categories.flatMap((c) => c.items.map((i) => i.itemId))])],
    usedCategoryIds: [...new Set([...prev.usedCategoryIds, ...sheet.categories.map((c) => c.categoryId)])],
  };
}

/** 임시 파일에 쓴 뒤 rename한다(부분 기록 방지). 임시 파일명은 호출마다 고유하다. */
function writeFileAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * 검증된 평가시트 여러 개를 하나의 단위로 override 저장한다(M-4).
 * 모든 임시 파일을 먼저 쓴 뒤 rename하며, 중간에 실패하면 이미 반영한 도메인을 이전 내용으로 되돌리고
 * 임시 파일을 정리한 뒤 예외를 다시 던진다. 개정 이력(history)은 먼저 기록한다(실패해도 ID가 재사용되지 않는 쪽이 안전).
 * 단일 프로세스 내 동시 호출은 호출자(서비스)가 직렬화해야 한다.
 */
export function saveEvalSheetOverrides(sheets: EvalSheet[]): void {
  const validated = sheets.map((s) => evalSheetSchema.parse(s));
  if (validated.length === 0) return;
  fs.mkdirSync(findOverrideDir(), { recursive: true });

  for (const sheet of validated) {
    writeFileAtomic(historyPath(sheet.domainId), JSON.stringify(mergedHistory(sheet), null, 2));
  }

  const suffix = `${process.pid}.${randomUUID()}`;
  const plans = validated.map((sheet) => {
    const file = overridePath(sheet.domainId);
    return { file, tmp: `${file}.${suffix}.tmp`, content: JSON.stringify(sheet, null, 2), backup: null as string | null, applied: false };
  });
  try {
    for (const p of plans) fs.writeFileSync(p.tmp, p.content, 'utf-8');
    for (const p of plans) {
      p.backup = fs.existsSync(p.file) ? fs.readFileSync(p.file, 'utf-8') : null;
      fs.renameSync(p.tmp, p.file);
      p.applied = true;
    }
  } catch (e) {
    for (const p of [...plans].reverse()) {
      if (!p.applied) continue;
      try {
        if (p.backup !== null) writeFileAtomic(p.file, p.backup);
        else fs.rmSync(p.file, { force: true });
      } catch {
        // 롤백 최선 노력: 원래 오류를 우선 보고한다.
      }
    }
    throw e;
  } finally {
    for (const p of plans) fs.rmSync(p.tmp, { force: true });
  }
}

/** 검증된 평가시트 1개를 override로 저장한다. */
export function saveEvalSheetOverride(sheet: EvalSheet): void {
  saveEvalSheetOverrides([sheet]);
}

/** override를 삭제하여 seed 평가시트로 되돌린다. 삭제했으면 true. (개정 이력은 유지한다.) */
export function removeEvalSheetOverride(domainId: string): boolean {
  const file = overridePath(domainId);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}

/** seed 원본 평가시트(override 무시). 개정판 버전 산정/초기화 비교용. */
export function loadSeedEvalSheet(domainId: string): EvalSheet {
  return loadSeed(domainId);
}

/** domainId에 해당하는 평가시트를 로드한다. override가 있으면 우선, 없으면 seed(프로세스 내 캐시). */
export function loadEvalSheet(domainId: string): EvalSheet {
  return readOverride(domainId) ?? loadSeed(domainId);
}

function loadSeed(domainId: string): EvalSheet {
  const cached = cache.get(domainId);
  if (cached) return cached;

  assertSupportedDomain(domainId);
  const fileName = FILE_BY_DOMAIN[domainId];

  const seedDir = findSeedDir();
  const filePath = path.join(seedDir, fileName);
  if (!fs.existsSync(filePath)) {
    throw new Error(`평가시트 파일을 찾을 수 없습니다: ${filePath}`);
  }

  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  const parsed = evalSheetSchema.parse(raw);
  cache.set(domainId, parsed);
  return parsed;
}

export function listSupportedDomainIds(): string[] {
  return Object.keys(FILE_BY_DOMAIN);
}
