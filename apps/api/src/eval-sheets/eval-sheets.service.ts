import { Injectable } from '@nestjs/common';
import { EvalSheet, loadEvalSheet } from '@auto-qa/eval-schema';

/**
 * seed/eval-sheets/*.json 로더 래퍼 (FR-3).
 * Phase 1은 telecom만 실제 채점에 사용하지만, 구조 검증 목적으로 다른 도메인도 로드 가능하다.
 */
@Injectable()
export class EvalSheetsService {
  getSheet(domainId: string): EvalSheet {
    return loadEvalSheet(domainId);
  }
}
