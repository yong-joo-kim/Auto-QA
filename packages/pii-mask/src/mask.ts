/**
 * 한국형 PII 정규식 기반 마스킹 (Phase 1 최소 구현).
 * 참고: docs/requirements/phase1-vertical-slice.md FR-2, NFR-1.3
 *
 * 100% 탐지를 보장하지 않는 "정규식 기반 최소 구현"이다(Phase 3에서 NER 등으로 고도화 예정).
 * 원문 그대로 노출되는 방식(단순 별표 개수 불일치 등)은 금지되므로, 탐지된 구간은 항상
 * 종류를 알 수 있는 고정 placeholder 문자열로 치환한다(길이 정보 등 원문 유추 단서를 남기지 않음).
 */

export interface PiiMaskResult {
  maskedText: string;
  /** 마스킹 종류별 탐지 건수 (감사/디버깅용, 원문 조각은 포함하지 않음) */
  counts: Record<PiiKind, number>;
}

export type PiiKind =
  | 'rrn'
  | 'phone'
  | 'card'
  | 'account'
  | 'email';

interface Rule {
  kind: PiiKind;
  pattern: RegExp;
  placeholder: string;
}

// 순서가 중요하다: 더 구체적인(자릿수가 특정적인) 패턴을 먼저 적용해
// 이후 패턴이 이미 마스킹된 placeholder 텍스트를 잘못 재매칭하지 않게 한다.
const RULES: Rule[] = [
  {
    kind: 'rrn',
    // 주민등록번호: 6자리-7자리 (예: 900101-1234567)
    pattern: /\b\d{6}[-\s]\d{7}\b/g,
    placeholder: '[주민등록번호]',
  },
  {
    kind: 'phone',
    // 휴대전화: 01[016789]-xxxx(3~4)-xxxx, 하이픈/공백 유무 모두 허용
    pattern: /\b01[016789][-\s]?\d{3,4}[-\s]?\d{4}\b/g,
    placeholder: '[전화번호]',
  },
  {
    kind: 'phone',
    // 유선전화: 0(2 또는 3~6 지역번호)-국번(3~4자리)-번호(4자리). 계좌번호 규칙보다 먼저 매칭되어야
    // "032-1234-5678" 같은 유선번호가 계좌번호로 오탐되지 않는다(M-4).
    pattern: /\b0(?:2|[3-6][1-9])[-\s]?\d{3,4}[-\s]?\d{4}\b/g,
    placeholder: '[전화번호]',
  },
  {
    kind: 'card',
    // 카드번호: 4자리 x 4그룹 (하이픈/공백/구분자 없음 모두 허용)
    pattern: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,
    placeholder: '[카드번호]',
  },
  {
    kind: 'account',
    // 계좌번호: best-effort, 하이픈으로 구분된 2~3개 숫자 그룹(은행마다 형식 상이).
    // 날짜(YYYY-MM-DD, 예: 2026-09-11) 패턴은 계좌번호가 아니므로 제외한다(M-4).
    // 유선전화(0X-XXXX-XXXX)는 위 phone 규칙에서 이미 치환되었으므로 이 시점에는 남아있지 않다.
    pattern: /\b(?!(?:19|20)\d{2}-\d{2}-\d{2}\b)\d{2,6}-\d{2,6}-\d{2,6}(?:-\d{1,6})?\b/g,
    placeholder: '[계좌번호]',
  },
  {
    kind: 'email',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    placeholder: '[이메일]',
  },
];

/** rawText를 마스킹한 maskedText를 반환한다. rawText는 이 함수 호출 이후 어디에도 보관하지 않아야 한다. */
export function maskPii(rawText: string): PiiMaskResult {
  let text = rawText;
  const counts: Record<PiiKind, number> = {
    rrn: 0,
    phone: 0,
    card: 0,
    account: 0,
    email: 0,
  };

  for (const rule of RULES) {
    text = text.replace(rule.pattern, () => {
      counts[rule.kind] += 1;
      return rule.placeholder;
    });
  }

  return { maskedText: text, counts };
}
