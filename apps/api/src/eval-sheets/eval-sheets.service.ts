import { BadRequestException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import {
  EvalSheet,
  EvalSheetOverrideCorruptError,
  getEvalSheetOverrideUpdatedAt,
  hasEvalSheetOverride,
  listSupportedDomainIds,
  loadEvalSheet,
  loadSeedEvalSheet,
  readEvalSheetHistory,
  removeEvalSheetOverride,
  saveEvalSheetOverrides,
} from '@auto-qa/eval-schema';
import { buildEvalSheetWorkbook, DomainHistoryInfo, parseEvalSheetWorkbook } from './eval-sheet-xlsx';

export interface EvalSheetSummary {
  domainId: string;
  domainName: string;
  version: string;
  totalMaxScore: number;
  categoryCount: number;
  itemCount: number;
  gatingItemCount: number;
  /** 업로드로 수정된 시트면 true (false = 기본 seed 시트) */
  customized: boolean;
  updatedAt?: string;
  /** 수정본 파일이 손상된 경우 true. 이때 요약 값은 기본(seed) 시트 기준이며 복원/재업로드가 필요하다. */
  corrupted?: boolean;
}

export interface UploadEvalSheetsResult {
  updated: { domainId: string; domainName: string; version: string; itemCount: number }[];
  ignoredSheets: string[];
}

/**
 * 평가시트 조회·Excel 업/다운로드 (FR-3 확장).
 * 채점 경로(TranscriptsService)는 `getSheet`만 사용하며, 업로드된 override가 있으면 자동으로 우선 적용된다.
 *
 * 쓰기 작업(importWorkbook/resetToDefault)은 프로세스 내 뮤텍스로 직렬화한다(M-4).
 * 단일 API 인스턴스(또는 override 디렉터리를 공유하지 않는 구성)를 전제로 한다.
 */
@Injectable()
export class EvalSheetsService {
  private writeQueue: Promise<unknown> = Promise.resolve();

  getSheet(domainId: string): EvalSheet {
    return loadEvalSheet(domainId);
  }

  /** 화면 조회용 단일 평가시트. 미지원 도메인은 404, 손상된 수정본은 원인 메시지와 함께 500. */
  getSheetDetail(domainId: string): EvalSheet {
    if (!listSupportedDomainIds().includes(domainId)) {
      throw new NotFoundException(`지원하지 않는 도메인입니다: ${domainId}`);
    }
    try {
      return loadEvalSheet(domainId);
    } catch (e) {
      if (e instanceof EvalSheetOverrideCorruptError) throw new InternalServerErrorException(e.message);
      throw e;
    }
  }

  list(): EvalSheetSummary[] {
    return listSupportedDomainIds().map((domainId) => {
      let sheet: EvalSheet;
      let corrupted = false;
      try {
        sheet = loadEvalSheet(domainId);
      } catch (e) {
        if (!(e instanceof EvalSheetOverrideCorruptError)) throw e;
        // 손상된 도메인 하나가 목록 전체를 막지 않도록 seed 기준으로 표시하고 복원 가능하게 한다(M-6).
        sheet = loadSeedEvalSheet(domainId);
        corrupted = true;
      }
      const updatedAt = getEvalSheetOverrideUpdatedAt(domainId);
      return {
        domainId,
        domainName: sheet.domainName,
        version: sheet.version,
        totalMaxScore: sheet.totalMaxScore,
        categoryCount: sheet.categories.length,
        itemCount: sheet.categories.reduce((n, c) => n + c.items.length, 0),
        gatingItemCount: sheet.categories.reduce((n, c) => n + c.items.filter((i) => i.gating).length, 0),
        customized: hasEvalSheetOverride(domainId),
        updatedAt: updatedAt?.toISOString(),
        ...(corrupted ? { corrupted: true } : {}),
      };
    });
  }

  /** 현재 유효한(override 우선) 10종 평가시트를 원본 양식의 xlsx로 생성. */
  exportWorkbook(): Promise<Buffer> {
    try {
      return buildEvalSheetWorkbook(listSupportedDomainIds().map((id) => loadEvalSheet(id)));
    } catch (e) {
      if (e instanceof EvalSheetOverrideCorruptError) throw new InternalServerErrorException(e.message);
      throw e;
    }
  }

  /**
   * 단일 도메인 평가시트를 xlsx로 생성. 탭 번호는 전체 10종 기준 순번을 유지해
   * 다운로드한 파일을 그대로 업로드해도 같은 도메인으로 인식된다.
   */
  exportDomainWorkbook(domainId: string): Promise<{ buffer: Buffer; domainName: string }> {
    const sheet = this.getSheetDetail(domainId);
    const ordinal = listSupportedDomainIds().indexOf(domainId) + 1;
    return buildEvalSheetWorkbook([sheet], [ordinal]).then((buffer) => ({ buffer, domainName: sheet.domainName }));
  }

  /**
   * xlsx 업로드 반영. 모든 탭을 먼저 검증하고, 오류가 하나라도 있으면 아무것도 반영하지 않는다(all-or-nothing).
   * 저장 단계도 도메인 간 원자적으로 처리되며(실패 시 롤백), 호출은 직렬화된다.
   */
  importWorkbook(buffer: Buffer): Promise<UploadEvalSheetsResult> {
    return this.serialized(() => this.doImport(buffer));
  }

  /** 업로드로 수정된 시트를 기본(seed) 시트로 되돌린다. */
  resetToDefault(domainId: string): Promise<void> {
    return this.serialized(async () => {
      if (!listSupportedDomainIds().includes(domainId)) {
        throw new NotFoundException(`지원하지 않는 도메인입니다: ${domainId}`);
      }
      if (!removeEvalSheetOverride(domainId)) {
        throw new BadRequestException('이미 기본 평가시트를 사용 중입니다.');
      }
    });
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(task, task);
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  private async doImport(buffer: Buffer): Promise<UploadEvalSheetsResult> {
    const result = await parseEvalSheetWorkbook(
      buffer,
      listSupportedDomainIds(),
      (id) => this.loadCurrentOrSeed(id),
      (id) => this.historyOf(id),
    );
    if (result.errors.length > 0) {
      throw new BadRequestException({
        message: result.errors,
        error: 'Bad Request',
        statusCode: 400,
      });
    }

    // 내용이 바뀌지 않은 시트는 버전만 올라가는 것을 막기 위해 건너뛴다.
    const changed = result.parsed.filter(({ domainId, sheet }) => hasChanged(this.tryLoadCurrent(domainId), sheet));
    saveEvalSheetOverrides(changed.map((c) => c.sheet));
    return {
      updated: changed.map(({ domainId, sheet }) => ({
        domainId,
        domainName: sheet.domainName,
        version: sheet.version,
        itemCount: sheet.categories.reduce((n, c) => n + c.items.length, 0),
      })),
      ignoredSheets: result.ignoredSheets,
    };
  }

  /** 수정본이 손상된 도메인은 seed를 기반으로 삼아 업로드로 복구할 수 있게 한다(M-6). */
  private loadCurrentOrSeed(domainId: string): EvalSheet {
    return this.tryLoadCurrent(domainId) ?? loadSeedEvalSheet(domainId);
  }

  private tryLoadCurrent(domainId: string): EvalSheet | undefined {
    try {
      return loadEvalSheet(domainId);
    } catch (e) {
      if (e instanceof EvalSheetOverrideCorruptError) return undefined;
      throw e;
    }
  }

  /** 개정 이력 + seed/현재 시트의 ID를 합쳐 재사용 금지 ID 집합과 최대 patch를 만든다(M-2/M-3). */
  private historyOf(domainId: string): DomainHistoryInfo {
    const history = readEvalSheetHistory(domainId);
    const seed = loadSeedEvalSheet(domainId);
    const sheets = [seed, this.tryLoadCurrent(domainId)].filter((s): s is EvalSheet => !!s);
    return {
      maxPatch: history.maxPatch,
      usedItemIds: [
        ...history.usedItemIds,
        ...sheets.flatMap((s) => s.categories.flatMap((c) => c.items.map((i) => i.itemId))),
      ],
      usedCategoryIds: [...history.usedCategoryIds, ...sheets.flatMap((s) => s.categories.map((c) => c.categoryId))],
    };
  }
}

/** 버전을 제외한 평가 기준 내용(카테고리/항목/메타)이 달라졌는지 비교. 현재 시트가 손상(undefined)이면 변경으로 본다. */
function hasChanged(current: EvalSheet | undefined, next: EvalSheet): boolean {
  if (!current) return true;
  const strip = (s: EvalSheet) => JSON.stringify({ ...s, version: undefined });
  return strip(current) !== strip(next);
}
