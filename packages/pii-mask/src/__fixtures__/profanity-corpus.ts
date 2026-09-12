/**
 * 비속어 탐지 회귀 테스트 골든 코퍼스 (FR-5.2, FR-5.4). 모든 문장은 합성 데이터다(FR-5.3).
 */

export interface ProfanityFalseCase {
  input: string;
  note: string;
}

export interface ProfanityTrueCase {
  input: string;
  speaker: 'customer' | 'agent';
  note: string;
}

/** detected === false 여야 하는 케이스(AC-P-1). */
export const FALSE_POSITIVE_CASES: ProfanityFalseCase[] = [
  { input: '상담사: 화면이 꺼져서요', note: 'AC-P-1 M-3' },
  { input: '상담사: 불이 꺼져 있어요', note: 'AC-P-1 M-3' },
  { input: '상담사: 전원이 꺼져버렸어요', note: 'AC-P-1 M-3' },
  { input: '고객: 시발점이 어디인가요', note: 'AC-P-1 M-3' },
  { input: '고객: 시발택시 타고 갑니다', note: 'AC-P-1 M-3' },
  { input: '고객: 시발역에서 출발합니다', note: 'AC-P-1 M-3' },
  { input: '상담사: 병신년(丙申年) 자료 확인했습니다', note: 'AC-P-1 M-3' },
  { input: '고객: 강아지 새끼를 키워요', note: 'AC-P-1 M-3' },
  { input: '고객: 새끼 줄 좀 주세요', note: 'AC-P-1 M-3' },
  { input: '고객: 새끼손가락이 아파요', note: 'AC-P-1 Phase1 회귀' },
  { input: '고객: 새끼발가락 다쳤어요', note: 'AC-P-1 Phase1 회귀' },
  { input: '고객: 새끼고양이 분양 문의입니다', note: 'AC-P-1 Phase1 회귀' },
  { input: '상담사: 개통 완료되었습니다', note: 'AC-P-1 신규("개"로 시작하는 정상어)' },
  {
    input: '고객: 미친 듯이 빠르네요',
    note:
      'AC-P-1 경계 사례 — 택1 확정: "미친"은 stem으로 등록하지 않고 "미친놈/미친년" 완전 형태만' +
      ' 복합어 사전으로 탐지한다. 따라서 이 문장은 미탐지(false)로 고정한다(profanity-data.ts 주석 참고).',
  },
];

/** detected === true 여야 하는 케이스(AC-P-2, 미탐 회귀 방지). */
export const TRUE_POSITIVE_CASES: ProfanityTrueCase[] = [
  { input: '고객: 씨발 언제까지 기다려야 해요', speaker: 'customer', note: 'AC-P-2' },
  { input: '고객: 시발 진짜 화나네', speaker: 'customer', note: 'AC-P-2' },
  { input: '고객: 개새끼야', speaker: 'customer', note: 'AC-P-2' },
  { input: '고객: 지랄하지 마세요', speaker: 'customer', note: 'AC-P-2' },
  { input: '고객: 미친놈 아니야', speaker: 'customer', note: 'AC-P-2 (복합어 사전)' },
  { input: '고객: 개소리 하지 마', speaker: 'customer', note: 'AC-P-2' },
  // M-4: FR-3.1 "공백·문장부호 기준 어절 분할" 미구현으로 어절 내부 문장부호 인접 비속어가
  // 미탐되던 케이스. 분할 로직을 문장부호까지 확장해 회복했다(profanity.ts TOKEN_DELIMITER_PATTERN).
  { input: '고객: 아니 씨발,진짜', speaker: 'customer', note: 'M-4 문장부호(쉼표) 인접' },
  { input: '고객: 씨발...진짜', speaker: 'customer', note: 'M-4 문장부호(말줄임표) 인접' },
  // M-4: 복합어 사전 미등록으로 미탐되던 명백한 합성 욕설. PROFANITY_COMPOUNDS에 추가해 회복했다.
  { input: '고객: 씨발새끼', speaker: 'customer', note: 'M-4 복합어 사전 보강' },
];

/**
 * M-4: 리뷰가 실측한 Phase 1 → Phase 3 미탐 전환 케이스 중, 이번 Phase 3에서 회복하지 않기로
 * (정책상 의도적으로) 결정한 항목들이다. 전부 fail-open(§1.1: 비속어는 애매하면 미탐지)
 * 방향이라 차단 사유는 아니지만, 향후 회귀 감시를 위해 "현재 정책상 false로 고정"됨을
 * 명시적으로 기록한다.
 *
 * - 허용 조사/어미 목록(`ALLOWED_ENDINGS`) 미포함으로 미탐: "지랄하네"(잔여 "하네"),
 *   "닥쳐라"(잔여 "라"), "씨발같은 소리"(잔여 "같은"), "병신같이"(잔여 "같이"),
 *   "지랄이야"(잔여 "이야"), "개소리하지마"(잔여 "하지마"). `ALLOWED_ENDINGS`를 넓히면
 *   §5.3이 경고한 대로 옵션 A와 같은 오탐 구조로 회귀할 위험이 커서 이번에는 확대하지 않는다.
 * - "새끼" 어간 미등록으로 미탐: "이 새끼가", "새끼야". "새끼"를 어간으로 등록하면
 *   "새끼손가락"/"새끼발가락"/"새끼고양이"/"새끼 줄 좀 주세요" 등 정상 표현과의 경계 판정이
 *   훨씬 복잡해져(현재는 이 표현들이 애초에 어간 불일치로 자동 제외되고 있음, L-2 참고)
 *   이번 Phase 범위에서는 다루지 않는다.
 *
 * 이 목록은 회귀 테스트 스윗(profanity.spec.ts)에서 `detected === false`로 고정 검증한다.
 */
export const KNOWN_FALSE_NEGATIVE_CASES: ProfanityFalseCase[] = [
  { input: '고객: 지랄하네', note: 'M-4 정책상 false 고정 — 허용 어미 미포함' },
  { input: '고객: 닥쳐라', note: 'M-4 정책상 false 고정 — 허용 어미 미포함' },
  { input: '고객: 씨발같은 소리', note: 'M-4 정책상 false 고정 — 허용 어미 미포함' },
  { input: '상담사: 병신같이', note: 'M-4 정책상 false 고정 — 허용 어미 미포함' },
  { input: '고객: 지랄이야', note: 'M-4 정책상 false 고정 — 허용 어미 미포함' },
  { input: '고객: 개소리하지마', note: 'M-4 정책상 false 고정 — 허용 어미 미포함' },
  { input: '고객: 이 새끼가', note: 'M-4 정책상 false 고정 — "새끼" 어간 미등록' },
  { input: '고객: 새끼야', note: 'M-4 정책상 false 고정 — "새끼" 어간 미등록' },
];

/**
 * "상담사: 저리 꺼져!" (AC-P-2 마지막 행)은 FR-3.4 폴백 규칙에 따라 "꺼져"를 사전에서
 * 제외했으므로 본 구현에서는 detected===false 로 확정한다(§1.1 fail-open, 요구사항이
 * 명시적으로 허용한 택1 중 하나 — mask.ts/profanity-data.ts 주석 참고). 별도 회귀 테스트로
 * 고정한다(profanity.spec.ts).
 */
export const KKEOJYEO_COMMAND_CASE = { input: '상담사: 저리 꺼져!', note: 'FR-3.4 폴백: 미탐지(false) 확정' };
