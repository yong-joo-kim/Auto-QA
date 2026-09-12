import { maskPii } from './mask';
import { detectProfanity } from './profanity';
import {
  LEAK_PREVENTION_CASES,
  FALSE_POSITIVE_CASES,
  PHASE1_REGRESSION_CASES,
  KNOWN_FALSE_NEGATIVE_CASES,
} from './__fixtures__/mask-corpus';

describe('maskPii — AC-L 유출 방지(마스킹되어야 함)', () => {
  test.each(LEAK_PREVENTION_CASES)('$note: $input', ({ input, expected }) => {
    expect(maskPii(input).maskedText).toBe(expected);
  });
});

describe('maskPii — AC-M 과탐 방지(마스킹되면 안 됨)', () => {
  test.each(FALSE_POSITIVE_CASES)('$note: $input', ({ input, expected }) => {
    expect(maskPii(input).maskedText).toBe(expected);
  });
});

describe('maskPii — L-4(R2) 알려진 잔존 미탐(정책상 회귀 감시용, 차단 아님)', () => {
  test.each(KNOWN_FALSE_NEGATIVE_CASES)('$note: $input', ({ input, expected }) => {
    expect(maskPii(input).maskedText).toBe(expected);
  });
});

describe('maskPii — AC-R-1 Phase 1 회귀 방지(차단 기준 — 절대 실패하면 안 됨)', () => {
  test.each(PHASE1_REGRESSION_CASES)('$note: $input', ({ input, expected }) => {
    expect(maskPii(input).maskedText).toBe(expected);
  });

  test('AC-R-1 혼합 문장: 전화+이메일+카드 동시 포함 시 각각 올바른 placeholder, 상호 간섭 없음', () => {
    const input = '전화 010-1234-5678, 이메일 test@example.com, 카드 1234-5678-9012-3456';
    const result = maskPii(input);
    expect(result.maskedText).toBe('전화 [전화번호], 이메일 [이메일], 카드 [카드번호]');
    expect(result.counts).toEqual({ rrn: 0, phone: 1, card: 1, account: 0, email: 1 });
  });
});

describe('maskPii — AC-R-2 PII 미포함 정상 문장 과탐 0건', () => {
  const normalSentences = [
    '안녕하세요 고객님, 무엇을 도와드릴까요?',
    '요금제 변경은 다음 달부터 적용됩니다.',
    '보험금 청구는 서류 접수 후 5영업일 내 처리됩니다.',
    '주문하신 상품은 내일 도착 예정입니다.',
    '민원 접수가 완료되었습니다. 감사합니다.',
    '진료 예약은 오전 9시부터 가능합니다.',
    '인터넷 속도 문제로 기사님이 방문하실 예정입니다.',
    '항공권 예약 변경 수수료는 3만원입니다.',
    '배달 기사님이 5분 내로 도착하실 예정입니다.',
    '전기 요금은 매월 10일에 청구됩니다.',
  ];

  test.each(normalSentences)('과탐 0건: %s', (sentence) => {
    const result = maskPii(sentence);
    expect(result.maskedText).toBe(sentence);
    expect(Object.values(result.counts).every((count) => count === 0)).toBe(true);
  });
});

describe('maskPii — AC-L-5 규칙 간 간섭 없음(FR-1.5)', () => {
  test('Luhn 통과 16자리 카드번호는 정확히 [카드번호] 1개이며 분해되지 않는다', () => {
    // 합성 Luhn 유효 카드번호(더미 값)
    const validCard = '4012888888888886';
    const result = maskPii(validCard);
    expect(result.maskedText).toBe('[카드번호]');
    expect(result.counts).toEqual({ rrn: 0, phone: 0, card: 1, account: 0, email: 0 });
  });

  test('이미 마스킹된 텍스트를 다시 마스킹해도 결과가 동일하다(멱등성)', () => {
    const input = '전화 010-1234-5678, 계좌 110-123-456789, 이메일 test@example.com';
    const once = maskPii(input).maskedText;
    const twice = maskPii(once).maskedText;
    expect(twice).toBe(once);
  });
});

describe('maskPii — NFR-3.3 예외 없이 처리되는 경계 입력', () => {
  test('빈 문자열', () => {
    expect(() => maskPii('')).not.toThrow();
    expect(maskPii('').maskedText).toBe('');
  });

  test('공백만', () => {
    expect(() => maskPii('   ')).not.toThrow();
  });

  test('개행만', () => {
    expect(() => maskPii('\n\n\n')).not.toThrow();
  });

  test('초장문 단일 라인(1MB)', () => {
    const longLine = '가'.repeat(1024 * 1024);
    expect(() => maskPii(longLine)).not.toThrow();
  });
});

describe('maskPii — NFR-3.2 성능(100KB 트랜스크립트 500ms 이내)', () => {
  test('100KB 트랜스크립트 처리 시간이 500ms 미만이다', () => {
    const chunk =
      '상담사: 안녕하세요 고객님. 연락처는 010-1234-5678 이고 이메일은 test@example.com 입니다. ' +
      '계좌번호 110-123-456789로 환불해드리겠습니다. 오늘은 2026-09-11 입니다.\n';
    const repeated = chunk.repeat(Math.ceil((100 * 1024) / chunk.length));

    const start = Date.now();
    maskPii(repeated);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
  });

  // test-automation(AC-N-1 보강): 리뷰 인계 사항 — 기존 스펙은 maskPii 단독으로만 측정했다.
  // 실제 상담 처리 파이프라인(transcripts.service.ts)은 maskPii 이후 detectProfanity를
  // 순차 호출하므로, 두 함수의 "합산" 처리 시간이 NFR-3.2(500ms)를 만족하는지 확인한다.
  test('100KB 트랜스크립트에 대한 maskPii + detectProfanity 합산 처리 시간이 500ms 미만이다', () => {
    const chunk =
      '상담사: 안녕하세요 고객님. 연락처는 010-1234-5678 이고 이메일은 test@example.com 입니다.\n' +
      '고객: 계좌번호 110-123-456789로 환불해주세요. 오늘은 2026-09-11 입니다.\n';
    const repeated = chunk.repeat(Math.ceil((100 * 1024) / chunk.length));

    const start = Date.now();
    const { maskedText } = maskPii(repeated);
    detectProfanity(maskedText);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(500);
  });

  // test-automation(M-1 회귀 방지): 1차 리뷰가 실측한 적대적 입력(이메일 규칙의 O(n^2)
  // 백트래킹, "12"+"-12"×34000 ≈ 102KB에서 4,811ms)의 시간 상한을 회귀 테스트로 고정한다.
  // 리뷰 3라운드 실측 기준(수정 후 27~37ms)에 여유를 둔 상한(1000ms)으로 고정해, 향후 이메일
  // 정규식이나 규칙 순서가 바뀌어도 다항 백트래킹이 재발하면 즉시 실패하게 한다.
  test('적대적 입력("12"+"-12"×34000, 102KB)이 1000ms 이내에 처리된다(M-1 회귀 방지)', () => {
    const adversarial = '12' + '-12'.repeat(34000);

    const start = Date.now();
    maskPii(adversarial);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
  });
});
