import { describe, test, expect } from 'vitest';
import { formatMaskingSummary } from './EvaluationMetaFooter';

/**
 * Phase 3 FR-4(M-5) 자동화 검증 부재 해소 — `formatMaskingSummary`(및 그 내부에서 호출되는
 * `isValidMaskingSummary`, export되지 않아 이 함수의 출력을 통해 간접 검증) 최소 4분기를
 * 고정한다(docs/design/phase3-pii-hardening-ui-spec.md §5, §6).
 *
 * 참고: docs/review/phase3-pii-hardening-review.md(M-5),
 *       docs/review/phase3-pii-hardening-review-round2.md §10 인계 사항.
 */
describe('formatMaskingSummary', () => {
  test('1분기: 정상 마스킹 요약(1건 이상 탐지) — 종류별 "N건" 나열', () => {
    const summary = { rrn: 0, phone: 2, card: 0, account: 0, email: 1 };
    expect(formatMaskingSummary(summary)).toBe('PII 마스킹: 전화번호 2건, 이메일 1건');
  });

  test('1분기(순서 고정 확인): 객체 키 순서와 무관하게 rrn > phone > card > account > email 순으로 나열된다', () => {
    const summary = { email: 1, account: 0, card: 1, phone: 0, rrn: 1 };
    expect(formatMaskingSummary(summary)).toBe('PII 마스킹: 주민등록번호 1건, 카드번호 1건, 이메일 1건');
  });

  test('2분기: 전부 0건 — "해당 없음"', () => {
    const summary = { rrn: 0, phone: 0, card: 0, account: 0, email: 0 };
    expect(formatMaskingSummary(summary)).toBe('PII 마스킹: 해당 없음');
  });

  test('3분기: null — "정보 없음"(레거시 레코드)', () => {
    expect(formatMaskingSummary(null)).toBe('PII 마스킹: 정보 없음 (이 평가는 집계 이전에 처리되었습니다)');
  });

  test('3분기: undefined — "정보 없음"(레거시 레코드)', () => {
    expect(formatMaskingSummary(undefined)).toBe(
      'PII 마스킹: 정보 없음 (이 평가는 집계 이전에 처리되었습니다)',
    );
  });

  test('4분기: 스펙 위반(빈 객체) — "해당 없음"이 아니라 "정보 없음"으로 방어 처리된다(UI 스펙 §5.3)', () => {
    // isValidMaskingSummary는 export되지 않으므로 formatMaskingSummary의 출력을 통해 간접 검증한다.
    expect(formatMaskingSummary({} as never)).toBe(
      'PII 마스킹: 정보 없음 (이 평가는 집계 이전에 처리되었습니다)',
    );
  });

  test('4분기: 스펙 위반(일부 키 누락) — "정보 없음"으로 방어 처리된다', () => {
    expect(formatMaskingSummary({ rrn: 0, phone: 1 } as never)).toBe(
      'PII 마스킹: 정보 없음 (이 평가는 집계 이전에 처리되었습니다)',
    );
  });

  test('4분기: 스펙 위반(비숫자 값 포함) — "정보 없음"으로 방어 처리된다', () => {
    expect(
      formatMaskingSummary({ rrn: 0, phone: '1', card: 0, account: 0, email: 0 } as never),
    ).toBe('PII 마스킹: 정보 없음 (이 평가는 집계 이전에 처리되었습니다)');
  });
});
