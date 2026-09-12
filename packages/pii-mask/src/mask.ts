/**
 * 한국형 PII 정규식 기반 마스킹 (Phase 1 최소 구현 → Phase 3 강화).
 * 참고: docs/requirements/phase1-vertical-slice.md FR-2, NFR-1.3
 *       docs/requirements/phase3-pii-hardening.md FR-1, FR-2, FR-1.5 (본 파일)
 *
 * 100% 탐지를 보장하지 않는 "정규식/규칙 기반" 구현이다. 사람 이름·주소 등 문맥 의존적인
 * PII는 여전히 탐지하지 못한다(NFR-1.4, Phase 3 이후에도 남는 한계). 탐지된 구간은 항상
 * 종류를 알 수 있는 고정 placeholder 문자열로 치환한다(길이 정보 등 원문 유추 단서를 남기지 않음).
 *
 * ── FR-1.5 구조 설계 (설계 권고 채택) ─────────────────────────────────────────
 * 규칙이 늘어날수록 "정규식 나열 + 순서 의존"의 유지보수 비용이 급증하므로, 아래
 * 2단계 구조로 리팩터링했다:
 *   1단계(구조적으로 명확한 패턴): 구분자(하이픈/점/공백/괄호/국가번호)가 있어 형태 자체로
 *      종류가 특정되는 패턴(전화번호/카드번호/계좌번호-하이픈/이메일/주민등록번호-하이픈)을
 *      규칙별 정규식으로 매칭·치환한다.
 *   2단계(구분자 없는 순수 숫자열 분류): 1단계 이후 남아있는 "구분자 없는 연속 숫자열"만을
 *      모두 찾아, 그 전체 길이와 문맥(직전 15자 키워드)·검증 로직(주민번호 날짜/성별코드,
 *      카드 Luhn)으로 종류를 분류한 뒤 치환한다.
 * 이 구조는 FR-1.5의 불변식을 "설계적으로" 보장한다:
 *   (1) placeholder는 한글 대괄호 텍스트만 포함하고 숫자/@ 문자를 포함하지 않으므로, 이후
 *       어떤 규칙도 이미 치환된 placeholder를 재매칭하지 않는다(정규식이애초에 매칭할 대상이
 *       없음).
 *   (2) 2단계는 "가장 긴 연속 숫자열 전체"를 하나의 토큰으로 보고 그 길이로 분류하므로,
 *       16자리 카드번호가 13자리 주민등록번호 규칙에 의해 부분 매칭되어 쪼개지는 일이 없다.
 *   (3) 1단계 내부의 순서 의존성(전화번호 → 카드번호 → 계좌번호-하이픈 순서)은 각 규칙
 *       주석에 이유를 남겼다.
 *
 * ── L-4(R2) 알려진 잔존 미탐(정규식/규칙 기반 한계, 회귀 아님) ───────────────────────────
 * 아래 4종은 Phase 3 라운드2 재리뷰에서 실측된 잔존 미탐이다. 각각 별도 회귀는 아니며(Phase 1도
 * 탐지하지 못했음), 향후 확장 시 참고용으로 문서화한다(자세한 코퍼스는 `__fixtures__/mask-corpus.ts`
 * `KNOWN_FALSE_NEGATIVE_CASES` 참고):
 *   1. `+82-2-1234-5678` — 국가번호(+82) 규칙은 휴대전화(`1[016789]`)만 대상으로 하고
 *      유선전화 지역번호(`2`, `3-6`)는 포함하지 않는다.
 *   2. `02)123-4567` — 괄호 지역번호 규칙은 여는/닫는 괄호가 모두 있는 `(02)` 형태만
 *      대상으로 하며, 여는 괄호가 없는 표기는 탐지하지 않는다.
 *   3. 구분자 없는 17자리 숫자 — 계좌번호 2단계 분류는 8~16자리만 대상으로 한다.
 *   4. Luhn 체크섬을 통과하지 못하는 구분자 없는 16자리 숫자 — FR-2.2에 따라 구분자 없는
 *      16자리는 Luhn 통과 시에만 카드번호로 판정한다(과탐 억제 우선, M-4).
 */

import { ACCOUNT_CONTEXT_KEYWORDS } from './mask-data';

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

const PLACEHOLDERS: Record<PiiKind, string> = {
  rrn: '[주민등록번호]',
  phone: '[전화번호]',
  card: '[카드번호]',
  account: '[계좌번호]',
  email: '[이메일]',
};

// 구분자 클래스. FR-1.1: 하이픈/점/공백(1개 이상)/구분자 없음을 모두 허용하고,
// 동일 번호 내에서 혼용(예: "010.1234-5678")도 허용해야 하므로 각 자리마다 독립적으로
// 선택 가능한 비캡처 그룹으로 정의한다. 점(.)은 전화번호·카드번호에만 사용한다(FR-1.1 제약:
// 계좌번호·주민등록번호에 점을 허용하면 IP/버전 문자열/소수점 금액 등에서 대량 과탐 발생).
// M-2/H-1(R2): 공백 구분자는 "같은 줄"의 공백류(스페이스/탭/NBSP(U+00A0)/전각공백(U+3000)/
// 얇은공백(U+2009)/VT/FF 등)를 전부 허용하되 개행(\r, \n)만 제외한다. 최초 M-2 수정은
// 서로 다른 줄에 놓인 4자리 숫자 4개(예: "1234\n5678\n9012\n3456")가 한 개의 16자리
// 카드번호로 잘못 병합되는 과탐을 막기 위해 `\s`(개행 포함)를 `[ \t]`로 축소했으나, 이는
// NBSP·전각공백 등 같은 줄의 다른 공백류까지 함께 제외해 Phase 1이 마스킹하던 케이스가
// 평문으로 남는 회귀를 만들었다(리뷰 라운드2 H-1(R2)). `[^\S\r\n]`(공백 문자 중 개행이
// 아닌 것)로 교체해 "개행만 제외"라는 원래 의도를 정확히 구현한다 — 개행 구분자 전화/카드
// 번호는 여전히(의도적으로) 마스킹하지 않는다(§7 AC-L-3 편차 기록 참고).
const PHONE_CARD_SEP = '(?:[-.]|[^\\S\\r\\n]+)?';
// "구분자가 있다"고 판단하려면 각 자리에 하이픈/점/공백류(개행 제외) 중 하나가 "반드시"
// 있어야 한다(카드번호 4-4-4-4/4-6-5 형태의 Luhn-무관 마스킹 판정, FR-2.2).
const MANDATORY_SEP = '(?:[-.]|[^\\S\\r\\n]+)';
// 주민등록번호(하이픈 규칙)는 기존 그대로 하이픈·공백(개행 포함, Phase 1 동작 유지)을 허용한다
// (점 금지, FR-1.1).
const RRN_ACCOUNT_SEP = '[-\\s]';
// M-2: 계좌번호(하이픈 구분) 규칙의 구분자는 하이픈만 허용한다. 과거 공백도 허용했으나
// FR-1.1/FR-1.4 어디에도 공백 구분자 요구가 없었고, 공백을 허용하면 "요금은 15000 20000
// 25000 중 선택하세요"처럼 문맥 키워드 없이 나열된 금액/포인트/번호가 계좌번호로 오탐되는
// 새 과탐 표면을 만든다(리뷰 M-2). 하이픈으로 환원한다.
const ACCOUNT_HYPHEN_SEP = '-';

interface SimpleRule {
  kind: PiiKind;
  pattern: RegExp;
}

// 순서가 중요하다(FR-1.5.3): 더 구체적인 패턴을 먼저 적용해 이후 규칙이 앞서 마스킹된
// placeholder(숫자를 포함하지 않음)나 다른 종류의 번호를 잘못 재해석하지 않게 한다.
const SIMPLE_RULES: SimpleRule[] = [
  {
    kind: 'rrn',
    // 주민등록번호(하이픈/공백 구분): 6자리-7자리 (예: 900101-1234567). Phase 1 회귀 유지.
    pattern: new RegExp(`\\b\\d{6}${RRN_ACCOUNT_SEP}\\d{7}\\b`, 'g'),
  },
  {
    kind: 'phone',
    // 휴대전화: 01[016789] + 3~4자리 + 4자리. 구분자는 하이픈/점/공백/없음, 혼용 허용(FR-1.1 L-1).
    pattern: new RegExp(`\\b01[016789]${PHONE_CARD_SEP}\\d{3,4}${PHONE_CARD_SEP}\\d{4}\\b`, 'g'),
  },
  {
    kind: 'phone',
    // 국가번호(+82) 표기 휴대전화: "+82-10-1234-5678", "+82 10 1234 5678"(FR-1.1).
    // 유선전화 규칙보다 먼저 적용해야 "+82-10-..."가 부분적으로 다른 규칙에 매칭되지 않는다.
    pattern: new RegExp(`\\+82${PHONE_CARD_SEP}1[016789]${PHONE_CARD_SEP}\\d{3,4}${PHONE_CARD_SEP}\\d{4}\\b`, 'g'),
  },
  {
    kind: 'phone',
    // 괄호 지역번호 유선전화: "(02)123-4567"(FR-1.1). 계좌번호 규칙보다 먼저 매칭되어야 한다.
    pattern: new RegExp(`\\(0(?:2|[3-6][1-9])\\)${PHONE_CARD_SEP}\\d{3,4}${PHONE_CARD_SEP}\\d{4}\\b`, 'g'),
  },
  {
    kind: 'phone',
    // 유선전화: 0(2 또는 3~6 지역번호)-국번(3~4자리)-번호(4자리). 계좌번호 규칙보다 먼저
    // 매칭되어야 "032-1234-5678" 같은 유선번호가 계좌번호로 오탐되지 않는다(M-4 회귀 방지).
    pattern: new RegExp(`\\b0(?:2|[3-6][1-9])${PHONE_CARD_SEP}\\d{3,4}${PHONE_CARD_SEP}\\d{4}\\b`, 'g'),
  },
  {
    kind: 'card',
    // 카드번호(구분자 "반드시" 존재, 4-4-4-4): 점 구분자 포함(FR-1.3). 구분자가 있으면
    // Luhn 통과 여부와 무관하게 마스킹한다(FR-2.2 — 오타/STT 오인식으로 체크섬이 깨진
    // 실제 카드번호를 놓치는 미탐(유출)이 더 심각하다는 §1.1 fail-closed 판단).
    // 카드번호 규칙이 계좌번호(하이픈) 규칙보다 먼저 적용되어야 "1234-5678-9012-3456"이
    // 계좌번호 규칙(숫자 2~6자리 그룹)에 의해 먼저 소비되지 않는다(FR-1.5.3).
    pattern: new RegExp(`\\b\\d{4}${MANDATORY_SEP}\\d{4}${MANDATORY_SEP}\\d{4}${MANDATORY_SEP}\\d{4}\\b`, 'g'),
  },
  {
    kind: 'card',
    // AMEX형 15자리(4-6-5), 구분자가 있는 형태만 대상(FR-1.3). Luhn 무관하게 마스킹(FR-2.2와
    // 동일 근거: 구분자 자체가 카드번호라는 강한 구조적 신호).
    pattern: new RegExp(`\\b\\d{4}${MANDATORY_SEP}\\d{6}${MANDATORY_SEP}\\d{5}\\b`, 'g'),
  },
  {
    kind: 'email',
    // M-1: 수량자에 상한을 부여해 ReDoS성 성능 저하를 차단한다. 계좌 규칙 변경(FR-2.1)으로
    // 짧은 숫자 그룹이 더 이상 소비되지 않게 되면서, 하이픈/점이 많이 섞인 긴 숫자열이 이메일
    // 규칙까지 도달해 `[A-Za-z0-9._%+-]+`의 `\b` 재시도가 O(n^2) 백트래킹을 유발했다
    // (100KB 적대적 입력에서 4.8초, NFR-3.2 500ms 위반). 로컬파트 64자·도메인 255자는 RFC
    // 5321 상한과 동일하며, 정상 이메일 탐지 범위에는 영향이 없다.
    // L-1(R2): 이 상한의 부작용으로 로컬파트가 65자 이상이면 `\b` 시작 경계 자체가 없어
    // 전혀 매칭되지 않는다(정상 이메일에는 영향 없음). RFC 5321 로컬파트 상한(64자)을
    // 벗어나는 길이이므로 의도적으로 마스킹 대상에서 제외한다(fail-closed 예외로 문서화).
    pattern: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,}\b/g,
  },
];

// 계좌번호(하이픈 구분) 후보 패턴. 날짜(YYYY-MM-DD)는 계좌번호가 아니므로 제외한다(M-4).
// 최종 마스킹 여부는 replace 콜백에서 총 숫자 자릿수(FR-2.1)를 추가로 검사한다.
// M-2: 구분자를 하이픈(ACCOUNT_HYPHEN_SEP)으로 한정한다(공백 구분자 철회).
const ACCOUNT_HYPHEN_PATTERN = new RegExp(
  `\\b(?!(?:19|20)\\d{2}-\\d{2}-\\d{2}\\b)\\d{2,6}${ACCOUNT_HYPHEN_SEP}\\d{2,6}${ACCOUNT_HYPHEN_SEP}\\d{2,6}(?:${ACCOUNT_HYPHEN_SEP}\\d{1,6})?\\b`,
  'g',
);

// H-1: 구분자가 "일부만" 있는 16자리 카드번호(예: "4012-8888-88888886", "4012-88888888-8886",
// "40128888 8888 8886", "1234-56789012-3456")를 탐지한다. 위 SIMPLE_RULES의 카드 규칙은
// 4-4-4-4/4-6-5처럼 "모든 자리 구분자 필수 + 고정 그룹 크기"를 요구하므로, 그룹 크기가
// 불규칙하게 나뉜 부분 구분자 카드번호를 놓친다(Phase 1 대비 회귀, AC-R-1 차단 기준).
// FR-2.2가 요구하는 "Luhn 검사"는 "구분자가 전혀 없는" 16자리에만 적용되고, 구분자가
// 위치에 관계없이 하나라도 있으면 Luhn 여부와 무관하게 마스킹해야 한다(§1.1 fail-closed).
// 이 패턴은 한 글자씩 소비하는 단일 반복(중첩 수량자 없음)이라 ReDoS 위험이 없다(NFR-3.1).
// H-1(R2): 구분자에 같은 줄의 공백류(개행 제외, `[^\S\r\n]`)도 포함한다 — 이전에는 탭이
// 구분자로 인식되지 않아 Phase 1 대비 마스킹 손실이 재발했다(리뷰 라운드2). 각 구분자
// 대안 뒤에는 `(?=\d)` lookahead를 둬 구분자가 토큰 끝에서 소비되지 않게 한다.
const CARD_PARTIAL_SEP_PATTERN = /\b\d(?:\d|[-.](?=\d)|[^\S\r\n](?=\d))*\d\b/g;

// M-1(R2): 카드 부분 구분자 후보 문자열을 구분자(하이픈/점 또는 개행이 아닌 공백류 연속
// 구간) 기준으로 나눠 "그룹"(연속 숫자 조각) 배열을 얻기 위한 분리자 패턴.
const CARD_GROUP_SPLIT_PATTERN = /[-.]|[^\S\r\n]+/;

// M-1(R2): 그룹 내부에 (19|20)YY-MM-DD 또는 (19|20)YY.MM.DD 형태의 날짜가 포함되면
// 카드번호 후보에서 제외한다(날짜 2개가 나열되어 우연히 합계 16자리가 되는 과탐 방지).
const CARD_DATE_LIKE_PATTERN = /(?:19|20)\d{2}[-.]\d{2}[-.]\d{2}/;

/**
 * H-1: 총 16자리 숫자 + 구분자(하이픈/점/공백류) 1개 이상(위치·그룹 크기 무관)을 카드번호로
 * 마스킹한다. 구분자가 전혀 없는 순수 숫자열은 이 규칙에서 건드리지 않고 그대로 두어(원문
 * 유지), 2단계(classifyRemainingDigitRuns)의 기존 Luhn 검사 경로로 넘긴다 — 이 규칙은 어디까지나
 * "구분자가 있는" 부분 구분자 카드번호만 보강하는 목적이다.
 *
 * M-1(R2): "총 16자리 + 구분자 존재"만으로 판정하면 서로 무관한 숫자 나열(날짜 2개, 소수
 * 금액 나열, 2자리 숫자 8개 나열 등)이 우연히 합계 16자리가 되어 통째로 오탐한다(예:
 * "가입일 2024-01-01 2025-12-31"). 아래 3개 구조 제약을 추가해 실제 카드번호 형태
 * (2~3개 그룹, 각 그룹 2~8자리)만 통과시킨다: ① 그룹 수 ≤ 4, ② 각 그룹 길이 2~8자리,
 * ③ 그룹 내부에 날짜 형태가 있으면 제외.
 *
 * L-2(R2)(알려진 한계): 위 제약으로 "9001011234567 123"(주민등록번호 13자리 + 공백 + 3자리)
 * 처럼 서로 무관한 숫자열이 합계 16자리가 되는 사례는 그룹 길이 상한(≤8)으로 해소했지만,
 * 이 규칙과 2단계 주민등록번호/계좌번호 분류는 완전히 독립적인 검사가 아니므로 다른 조합의
 * 인접 숫자열에서 종류가 잘못 귀속될 여지가 이론적으로 남는다(유출 방향은 아님 — 마스킹
 * 자체는 되므로 §1.1 fail-closed 기준은 충족).
 */
function applyCardPartialSeparatorRule(text: string, counts: Record<PiiKind, number>): string {
  return text.replace(CARD_PARTIAL_SEP_PATTERN, (match) => {
    const groups = match.split(CARD_GROUP_SPLIT_PATTERN).filter((group) => group.length > 0);
    if (groups.length <= 1) return match; // 구분자 없음: 2단계 Luhn 검사로 위임(변경하지 않음).
    const digitCount = groups.join('').length;
    if (digitCount !== 16) return match; // 카드번호가 아닌 다른 길이는 이후 단계에서 처리.
    if (groups.length > 4) return match; // M-1(R2): 그룹이 너무 많으면(날짜/소수 나열 등) 제외.
    if (groups.some((group) => group.length < 2 || group.length > 12)) return match; // M-1(R2)/H-1(R3): 그룹 길이 제약 (4-12/12-4 레이아웃 보존을 위해 상한 12).
    if (CARD_DATE_LIKE_PATTERN.test(match)) return match; // M-1(R2): 날짜 형태 포함 시 제외.
    counts.card += 1;
    return PLACEHOLDERS.card;
  });
}

/** 후보 위치 앞 15자 이내에 계좌 문맥 키워드가 있는지 검사한다(FR-1.4, FR-2.1). */
function hasAccountContext(fullText: string, matchStartIndex: number): boolean {
  const windowStart = Math.max(0, matchStartIndex - 15);
  const preceding = fullText.slice(windowStart, matchStartIndex);
  return ACCOUNT_CONTEXT_KEYWORDS.some((keyword) => preceding.includes(keyword));
}

/**
 * 계좌번호(하이픈 구분) 규칙 적용. FR-2.1: 구분자를 제외한 총 숫자 자릿수가 10자리
 * 이상이어야 계좌번호로 판정한다(문맥 키워드가 근접하면 8자리로 완화). 이 기준만으로
 * "상품코드 123-456-789"(9자리), "요금 12-34-56"(6자리) 같은 과탐이 자연히 제외된다(M-4).
 */
function applyAccountHyphenRule(text: string, counts: Record<PiiKind, number>): string {
  return text.replace(ACCOUNT_HYPHEN_PATTERN, (match, offset: number, full: string) => {
    const digitCount = match.replace(/[-\s]/g, '').length;
    const minDigits = hasAccountContext(full, offset) ? 8 : 10;
    if (digitCount < minDigits) return match; // 과탐 억제(FR-2.1): 마스킹하지 않음
    counts.account += 1;
    return PLACEHOLDERS.account;
  });
}

/** 주민등록번호(구분자 없는 13자리) 형태 유효성 검사(FR-1.2). 체크섬(모듈러 11)은 사용하지
 * 않는다 — STT 오인식/오타로 체크섬이 깨진 실제 주민번호가 마스킹되지 않는 미탐(유출) 위험이
 * 과탐 감소 이익보다 크기 때문이다(§1.1 fail-closed). */
function isValidUnseparatedRrnShape(digits: string): boolean {
  if (digits.length !== 13) return false;
  const month = Number(digits.slice(2, 4));
  const day = Number(digits.slice(4, 6));
  const genderCode = Number(digits[6]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 && genderCode >= 1 && genderCode <= 8;
}

/** Luhn 체크섬 검사(FR-2.2). 구분자 없는 16자리 카드번호 후보에만 사용한다. 검사 결과는
 * 마스킹 여부 판정에만 쓰고, 값 자체를 로그 등에 남기지 않는다(FR-2.2). */
function passesLuhnCheck(digits: string): boolean {
  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48; // '0' → 0
    if (shouldDouble) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

/** M-3: 8자리 숫자열이 YYYYMMDD 형태의 유효한 날짜인지 검사한다. 계좌 문맥 키워드가 근접해
 * 있어도 날짜 형태는 계좌번호로 오판하지 않는다 — "입금은 20260911 에 했습니다"처럼
 * 입금/이체/송금 키워드는 날짜와 같은 문장에 등장할 확률이 높아 8자리 완화 조건과 결합되면
 * 날짜를 계좌번호로 오탐한다(리뷰 M-3). (19|20)로 시작하는 연도 + 유효 월/일만 제외한다. */
function isLikelyYyyymmddDate(digits: string): boolean {
  if (digits.length !== 8) return false;
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  return (
    (year >= 1900 && year <= 2099) && month >= 1 && month <= 12 && day >= 1 && day <= 31
  );
}

type DigitRunClassification = { kind: PiiKind } | null;

/**
 * 1단계 처리 후 남은, 구분자 없는 연속 숫자열 하나를 분류한다(FR-1.5의 2단계 구조 핵심).
 * 우선순위: 계좌 문맥 키워드가 근접해 있으면 계좌번호를 최우선으로 판정한다(FR-1.4 예시:
 * "계좌번호 1101234567890"은 우연히 주민등록번호 형태 조건도 만족하지만, 문맥상 계좌번호로
 * 판정해야 한다). 문맥이 없을 때만 주민등록번호(13자리)·카드번호(16자리, Luhn) 형태 검사로
 * 넘어간다.
 */
function classifyDigitRun(digits: string, fullText: string, offset: number): DigitRunClassification {
  const len = digits.length;

  // FR-1.4 + FR-2.1: 구분자 없는 계좌번호는 문맥 키워드가 "항상" 필요하다(과탐 억제).
  // 문맥이 있으면 길이 기준을 10자리→8자리로 완화한다. 단, M-3: 8자리이면서 YYYYMMDD
  // 날짜 형태이면 계좌번호로 판정하지 않는다(날짜 오탐 방지).
  if (hasAccountContext(fullText, offset) && len >= 8 && len <= 16) {
    if (!(len === 8 && isLikelyYyyymmddDate(digits))) {
      return { kind: 'account' };
    }
  }

  if (len === 13 && isValidUnseparatedRrnShape(digits)) {
    return { kind: 'rrn' };
  }

  if (len === 16 && passesLuhnCheck(digits)) {
    return { kind: 'card' };
  }

  return null;
}

const DIGIT_RUN_PATTERN = /\d+/g;

/** 2단계: 구분자 없는 순수 숫자열을 분류하여 치환한다. */
function classifyRemainingDigitRuns(text: string, counts: Record<PiiKind, number>): string {
  return text.replace(DIGIT_RUN_PATTERN, (match, offset: number, full: string) => {
    // 성능(NFR-3.2) 및 오탐 방지를 위해, 어떤 종류로도 분류될 수 없는 짧은 숫자열은 즉시
    // 건너뛴다(가장 짧은 대상 길이는 계좌번호의 문맥 완화 임계값인 8자리).
    if (match.length < 8) return match;

    const classification = classifyDigitRun(match, full, offset);
    if (!classification) return match;

    counts[classification.kind] += 1;
    return PLACEHOLDERS[classification.kind];
  });
}

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

  // 1단계: 구분자/접두 표기 등 구조적으로 명확한 패턴.
  for (const rule of SIMPLE_RULES) {
    text = text.replace(rule.pattern, () => {
      counts[rule.kind] += 1;
      return PLACEHOLDERS[rule.kind];
    });
  }
  // H-1: 부분 구분자 16자리 카드번호 보강. 계좌번호(하이픈) 규칙보다 먼저 적용해 카드번호
  // 규칙이 계좌번호 규칙보다 우선한다는 FR-1.5.3 순서 원칙을 유지한다.
  text = applyCardPartialSeparatorRule(text, counts);
  text = applyAccountHyphenRule(text, counts);

  // 2단계: 구분자 없는 순수 숫자열 분류(FR-1.2, FR-1.4, FR-2.2).
  text = classifyRemainingDigitRuns(text, counts);

  return { maskedText: text, counts };
}
