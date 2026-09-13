import { detectProfanity } from './profanity';
import {
  FALSE_POSITIVE_CASES,
  TRUE_POSITIVE_CASES,
  KKEOJYEO_COMMAND_CASE,
  KNOWN_FALSE_NEGATIVE_CASES,
} from './__fixtures__/profanity-corpus';

describe('detectProfanity — AC-P-1 오탐 제거(detected === false)', () => {
  test.each(FALSE_POSITIVE_CASES)('$note: $input', ({ input }) => {
    expect(detectProfanity(input).detected).toBe(false);
  });

  test('FR-3.4 폴백 확정: "저리 꺼져!"는 미탐지(false)로 고정한다', () => {
    expect(detectProfanity(KKEOJYEO_COMMAND_CASE.input).detected).toBe(false);
  });
});

describe('detectProfanity — M-4 알려진 미탐 한계(정책상 false로 고정, 회귀 감시용)', () => {
  test.each(KNOWN_FALSE_NEGATIVE_CASES)('$note: $input', ({ input }) => {
    expect(detectProfanity(input).detected).toBe(false);
  });
});

describe('detectProfanity — AC-P-2 진짜 비속어 탐지 유지(미탐 회귀 방지)', () => {
  test.each(TRUE_POSITIVE_CASES)('$note: $input', ({ input, speaker }) => {
    const result = detectProfanity(input);
    expect(result.detected).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].speaker).toBe(speaker);
  });

  test('matches[].maskedText에 비속어 원문이 남아 있지 않다(* 치환 확인)', () => {
    const result = detectProfanity('고객: 씨발 언제까지 기다려야 해요');
    expect(result.matches[0].maskedText).not.toContain('씨발');
    expect(result.matches[0].maskedText).toContain('***');
  });

  test('matches[].maskedText에 화자 접두어가 포함되지 않는다', () => {
    const result = detectProfanity('고객: 씨발 언제까지 기다려야 해요');
    expect(result.matches[0].maskedText).not.toMatch(/고객[:：]/);
  });

  test('비속어가 포함되지 않은 줄은 matches에 포함되지 않는다(전체 대화 미노출)', () => {
    const transcript = ['상담사: 안녕하세요 고객님.', '고객: 씨발 언제까지 기다려야 해요', '상담사: 죄송합니다.'].join(
      '\n',
    );
    const result = detectProfanity(transcript);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].maskedText).toContain('***');
  });
});

describe('detectProfanity — AC-P-3 화자 귀속 회귀', () => {
  test('화자 접두어 없이 시작하는 줄은 직전 화자에 귀속된다', () => {
    const transcript = ['고객: 씨발 진짜', '개소리 하지 마'].join('\n');
    const result = detectProfanity(transcript);
    expect(result.matches).toHaveLength(2);
    expect(result.matches.every((m) => m.speaker === 'customer')).toBe(true);
  });

  test('최초 화자 표기가 없으면 agent로 간주한다', () => {
    const transcript = '씨발 이거 왜 이래';
    const result = detectProfanity(transcript);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].speaker).toBe('agent');
  });
});

describe('detectProfanity — NFR-3.3 예외 없이 처리되는 경계 입력', () => {
  test('빈 문자열', () => {
    expect(() => detectProfanity('')).not.toThrow();
    expect(detectProfanity('').detected).toBe(false);
  });

  test('공백만', () => {
    expect(() => detectProfanity('   ')).not.toThrow();
  });

  test('개행만', () => {
    expect(() => detectProfanity('\n\n\n')).not.toThrow();
  });

  // test-automation(AC-N-2 보강): 리뷰 인계 사항 — detectProfanity의 1MB 단일 라인 경계
  // 테스트가 없었다(maskPii만 1MB 경계를 검증). 화자 접두어 파싱(줄바꿈 split)과 어절
  // 토크나이저(TOKEN_DELIMITER_PATTERN) 모두 단일 초장문 라인에서 예외 없이 처리되어야 한다.
  test('1MB 단일 라인(한글)', () => {
    const longLine = '상담사: ' + '안녕하세요 '.repeat(100000);
    expect(() => detectProfanity(longLine)).not.toThrow();
  });

  // test-automation(AC-N-2 보강): 어절 토크나이저가 "공백·문장부호·기호"를 구분자로 삼으므로
  // (M-4, FR-3.1), 문장부호/기호가 극단적으로 밀집된 입력이 토크나이저 최악 케이스다. 예외
  // 없이 처리되고, ReDoS 성 지연이 없는지(NFR-3.1) 함께 확인한다.
  test('1MB 문장부호/기호 밀집 입력', () => {
    const dense = '.,!?~-…·()[]{}'.repeat(80000); // 약 1.1MB

    const start = Date.now();
    expect(() => detectProfanity(dense)).not.toThrow();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
  });

  // L-3(리뷰 정리): 문장부호가 매우 많은 입력에서 문장 분리 개수만큼 matches가 무한정 커질 수
  // 있었다(실측 10만 건 이상). 상한(500)을 넘지 않아야 한다.
  test('문장부호가 매우 많은 입력에서도 matches가 상한(500건)을 넘지 않는다', () => {
    const dense = '씨발!'.repeat(10000);

    const result = detectProfanity(dense);

    expect(result.matches.length).toBeLessThanOrEqual(500);
    expect(result.matches.length).toBeGreaterThan(0);
  });
});

describe('detectProfanity — 문장 단위 출력(PM 요청, 2026-09-13 — FR-3.5 addendum)', () => {
  test('한 줄에 비속어 문장과 무관한 문장이 섞여 있으면 비속어 문장만 반환한다', () => {
    const transcript =
      '상담사: 안녕하세요 오늘 확인해보니 처리가 늦어져서 죄송합니다. 근데 진짜 씨발 왜 이렇게 오래 걸려요. 빨리 좀 해주세요';
    const result = detectProfanity(transcript);

    expect(result.matches).toHaveLength(1);
    // L-4(리뷰 정리): not.toContain 대신 전체 문장을 toBe로 고정해 분리 경계 오류(예: 앞/뒤
    // 문장의 일부가 섞여 들어오는 회귀)까지 잡는다.
    expect(result.matches[0].maskedText).toBe('근데 진짜 *** 왜 이렇게 오래 걸려요.');
  });

  // L-1(리뷰 정리): 숫자 사이의 "."(예: "3.5만원")은 소수점이지 문장 종결이 아니다. 이를
  // 종결부호로 오인하면 "5만원인데 *** 뭐야"처럼 숫자 중간에서 문장이 잘려 화면에 어색하게
  // 노출된다. 탐지된 문장이 숫자 표현을 온전히 포함해야 한다.
  test('숫자 사이의 마침표(소수점)는 문장 종결로 취급하지 않아 문장이 잘리지 않는다', () => {
    const result = detectProfanity('고객: 요금이 3.5만원인데 씨발 뭐야');

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].maskedText).toBe('요금이 3.5만원인데 *** 뭐야');
  });

  test('소수점 뒤에 실제 문장 종결이 있으면 그 지점에서는 정상적으로 분리된다', () => {
    const transcript = '고객: 요금이 3.5만원이에요. 진짜 씨발 너무 비싸요.';
    const result = detectProfanity(transcript);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].maskedText).toBe('진짜 *** 너무 비싸요.');
  });

  test('한 줄에 서로 다른 문장으로 비속어가 2건 있으면 matches가 2건으로 분리된다', () => {
    const transcript = '고객: 씨발 이거 왜 이래요. 진짜 개소리 하지 마세요.';
    const result = detectProfanity(transcript);

    expect(result.matches).toHaveLength(2);
    expect(result.matches.every((m) => m.speaker === 'customer')).toBe(true);
    expect(result.matches[0].maskedText).toContain('***');
    expect(result.matches[1].maskedText).toContain('***');
  });

  test('문장부호 없는 짧은 발화는 회귀 없이 줄 전체가 그대로 매치된다', () => {
    const result = detectProfanity('고객: 씨발 언제까지 기다려야 해요');
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].maskedText).toContain('***');
    expect(result.matches[0].maskedText).toBe('*** 언제까지 기다려야 해요');
  });
});

describe('detectProfanity — NFR-3.6 결정론성', () => {
  test('동일 입력에 항상 동일한 결과를 반환한다', () => {
    const input = '고객: 씨발 언제까지 기다려야 해요\n상담사: 화면이 꺼져서요';
    const r1 = detectProfanity(input);
    const r2 = detectProfanity(input);
    expect(r1).toEqual(r2);
  });

  // L-4(리뷰 정리): 신규 문장 분리 경로(splitIntoSentences)가 결정론성 테스트에도 커버되도록
  // 다문장 입력(소수점 포함 + 문장 분리 2건)을 추가한다.
  test('다문장 입력(소수점 포함)에도 항상 동일한 결과를 반환한다', () => {
    const input = '고객: 요금이 3.5만원인데 씨발 뭐야. 진짜 개소리 그만하세요.\n상담사: 화면이 꺼져서요';
    const r1 = detectProfanity(input);
    const r2 = detectProfanity(input);
    expect(r1).toEqual(r2);
    expect(r1.matches).toHaveLength(2);
  });
});
