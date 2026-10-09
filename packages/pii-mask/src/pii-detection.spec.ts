import { detectPii } from './pii-detection';
import { maskPii } from './mask';

describe('detectPii — PII 미탐지(detected === false)', () => {
  test('PII placeholder가 없는 일반 대화는 미탐지', () => {
    const transcript = '상담사: 안녕하세요 고객님.\n고객: 네 확인 부탁드립니다.';
    expect(detectPii(transcript).detected).toBe(false);
  });

  test('빈 문자열', () => {
    expect(() => detectPii('')).not.toThrow();
    expect(detectPii('').detected).toBe(false);
  });
});

describe('detectPii — PII 탐지(비속어 탐지와 동일한 문장 단위 출력)', () => {
  test('전화번호 placeholder가 포함된 문장만 반환한다(전체 대화 미노출)', () => {
    const transcript = [
      '상담사: 안녕하세요 고객님.',
      '고객: 제 번호는 [전화번호] 입니다.',
      '상담사: 확인 감사합니다.',
    ].join('\n');
    const result = detectPii(transcript);

    expect(result.detected).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].speaker).toBe('customer');
    expect(result.matches[0].maskedText).toBe('제 번호는 [전화번호] 입니다.');
  });

  test('한 줄에 PII 포함 문장과 무관한 문장이 섞여 있으면 PII 문장만 반환한다', () => {
    const transcript =
      '고객: 확인 감사합니다. 계좌번호는 [계좌번호] 입니다. 빨리 처리해주세요.';
    const result = detectPii(transcript);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].maskedText).toBe('계좌번호는 [계좌번호] 입니다.');
  });

  test('한 줄에 서로 다른 문장으로 PII가 2건 있으면 matches가 2건으로 분리된다', () => {
    const transcript = '고객: 이메일은 [이메일] 입니다. 카드번호는 [카드번호] 이에요.';
    const result = detectPii(transcript);

    expect(result.matches).toHaveLength(2);
    expect(result.matches.every((m) => m.speaker === 'customer')).toBe(true);
  });

  test('화자 접두어 없이 시작하는 줄은 직전 화자에 귀속된다', () => {
    const transcript = ['고객: 확인해보니', '제 번호는 [전화번호] 이에요'].join('\n');
    const result = detectPii(transcript);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].speaker).toBe('customer');
  });

  test('PII 문장에 비속어가 함께 있으면 욕설도 함께 마스킹되어 원문이 노출되지 않는다', () => {
    const transcript = '고객: 씨발 제 번호는 [전화번호] 입니다.';
    const result = detectPii(transcript);

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].maskedText).not.toContain('씨발');
    expect(result.matches[0].maskedText).toContain('***');
    expect(result.matches[0].maskedText).toContain('[전화번호]');
  });

  test('여러 종류의 PII가 함께 있는 실제 마스킹 결과에서도 탐지된다(maskPii 연동)', () => {
    const { maskedText } = maskPii(
      '상담사: 연락처 확인 부탁드립니다.\n고객: 010-1234-5678이고 이메일은 test@example.com 이에요.',
    );
    const result = detectPii(maskedText);

    expect(result.detected).toBe(true);
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].maskedText).toContain('[전화번호]');
    expect(result.matches[0].maskedText).toContain('[이메일]');
  });
});

describe('detectPii — NFR-3.3 예외 없이 처리되는 경계 입력', () => {
  test('공백만', () => {
    expect(() => detectPii('   ')).not.toThrow();
  });

  test('1MB 단일 라인(한글)', () => {
    const longLine = '상담사: ' + '안녕하세요 '.repeat(100000);
    expect(() => detectPii(longLine)).not.toThrow();
  });

  test('PII 문장이 매우 많은 입력에서도 matches가 상한(500건)을 넘지 않는다', () => {
    const dense = '연락처는 [전화번호] 입니다.'.repeat(10000);

    const result = detectPii(dense);

    expect(result.matches.length).toBeLessThanOrEqual(500);
    expect(result.matches.length).toBeGreaterThan(0);
  });
});

describe('detectPii — 결정론성', () => {
  test('동일 입력에 항상 동일한 결과를 반환한다', () => {
    const input = '고객: 제 번호는 [전화번호] 입니다.\n상담사: 네 확인했습니다.';
    const r1 = detectPii(input);
    const r2 = detectPii(input);
    expect(r1).toEqual(r2);
  });
});
