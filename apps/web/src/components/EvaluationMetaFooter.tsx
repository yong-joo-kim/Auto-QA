import type { MaskingSummary } from '@auto-qa/shared-types';

interface EvaluationMetaFooterProps {
  evalSheetVersion: string;
  llmProvider: string;
  llmModel: string;
  sourceCitation?: string;
  disclaimer?: string;
  maskingSummary?: MaskingSummary | null;
}

/**
 * Phase 3 FR-4 — PII 마스킹 종류별 표시 순서(고정, 백엔드 응답 객체의 키 순서에 의존하지 않는다).
 * 근거: `packages/pii-mask`의 `PiiKind` 정의 순서 및 심각도(주민등록번호가 가장 민감) 기준.
 * (참고: docs/design/phase3-pii-hardening-ui-spec.md §2.1)
 */
const MASKING_SUMMARY_ORDER = ['rrn', 'phone', 'card', 'account', 'email'] as const;

const MASKING_SUMMARY_LABELS: Record<(typeof MASKING_SUMMARY_ORDER)[number], string> = {
  rrn: '주민등록번호',
  phone: '전화번호',
  card: '카드번호',
  account: '계좌번호',
  email: '이메일',
};

const MASKING_SUMMARY_UNKNOWN_TEXT = 'PII 마스킹: 정보 없음 (이 평가는 집계 이전에 처리되었습니다)';

/**
 * `summary`가 스펙(§6 `MaskingSummary` = 5종 키를 모두 숫자로 포함하는 객체)을 만족하는지 검증한다.
 * 빈 객체·일부 키 누락·비숫자 값 등 스펙 위반 데이터는 false를 반환하며,
 * 호출부는 이를 "탐지 0건(해당 없음)"과 구분해 "정보 없음"으로 표시해야 한다
 * (docs/design/phase3-pii-hardening-ui-spec.md §5.3).
 */
function isValidMaskingSummary(summary: unknown): summary is MaskingSummary {
  if (typeof summary !== 'object' || summary === null) {
    return false;
  }
  return MASKING_SUMMARY_ORDER.every((kind) => typeof (summary as Record<string, unknown>)[kind] === 'number');
}

/**
 * PII 마스킹 요약 한 줄 문구를 조립하는 순수 함수.
 * (docs/design/phase3-pii-hardening-ui-spec.md §6 의사코드 그대로 구현,
 * §5.3 방어 규칙에 따라 스펙 위반 데이터도 "정보 없음"으로 처리한다)
 */
export function formatMaskingSummary(summary: MaskingSummary | null | undefined): string {
  if (summary == null) {
    return MASKING_SUMMARY_UNKNOWN_TEXT;
  }

  if (!isValidMaskingSummary(summary)) {
    return MASKING_SUMMARY_UNKNOWN_TEXT;
  }

  const parts: string[] = [];
  for (const kind of MASKING_SUMMARY_ORDER) {
    const count = summary[kind];
    if (count > 0) {
      parts.push(`${MASKING_SUMMARY_LABELS[kind]} ${count}건`);
    }
  }

  if (parts.length === 0) {
    return 'PII 마스킹: 해당 없음';
  }

  return `PII 마스킹: ${parts.join(', ')}`;
}

export function EvaluationMetaFooter({
  evalSheetVersion,
  llmProvider,
  llmModel,
  sourceCitation,
  disclaimer,
  maskingSummary,
}: EvaluationMetaFooterProps) {
  return (
    <div className="footnote-block">
      {sourceCitation && <div className="footnote-text">출처(컴플라이언스 근거): {sourceCitation}</div>}
      {disclaimer && <div className="footnote-text">※ {disclaimer}</div>}
      <div className="footnote-text">{formatMaskingSummary(maskingSummary)}</div>
      <div className="footnote-text">
        평가시트 v{evalSheetVersion} · Provider: {llmProvider} ({llmModel})
      </div>
    </div>
  );
}
