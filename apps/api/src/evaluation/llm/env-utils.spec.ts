import { Logger } from '@nestjs/common';
import { assertHeaderSafeApiKeyFormat, parseFloatEnv, parseIntEnv } from './env-utils';

/**
 * 순수 로직 단위 테스트 (`env-utils.ts`는 이전까지 전용 스펙이 없었고, 프로바이더/모듈 스펙을
 * 통해서만 간접적으로 커버되었다). FR-2.4(숫자형 env 파싱)와 H-1(키 형식 검증) 방어 로직을
 * 직접 겨냥해 고정한다.
 */
describe('parseIntEnv', () => {
  const logger = new Logger('env-utils.spec');
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as Logger);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test('undefined면 기본값을 반환하고 경고를 남기지 않는다', () => {
    expect(parseIntEnv(undefined, 42, 'TEST_ENV', logger)).toBe(42);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('빈 문자열(공백만 포함)이면 기본값을 반환하고 경고를 남기지 않는다', () => {
    expect(parseIntEnv('   ', 42, 'TEST_ENV', logger)).toBe(42);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('유효한 정수 문자열은 그대로 파싱된다', () => {
    expect(parseIntEnv('7', 42, 'TEST_ENV', logger)).toBe(7);
  });

  test('숫자로 해석할 수 없는 값이면 기본값으로 대체하고 경고를 남긴다(값 자체는 로그에 남음)', () => {
    expect(parseIntEnv('abc', 42, 'TEST_ENV', logger)).toBe(42);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('TEST_ENV=abc');
  });
});

describe('parseFloatEnv', () => {
  const logger = new Logger('env-utils.spec');
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => undefined as unknown as Logger);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  test('undefined면 기본값을 반환한다', () => {
    expect(parseFloatEnv(undefined, 0, 'TEST_TEMP', logger)).toBe(0);
  });

  test('유효한 소수 문자열은 그대로 파싱된다', () => {
    expect(parseFloatEnv('0.7', 0, 'TEST_TEMP', logger)).toBeCloseTo(0.7);
  });

  test('숫자로 해석할 수 없는 값이면 기본값으로 대체하고 경고를 남긴다', () => {
    expect(parseFloatEnv('not-a-number', 0.3, 'TEST_TEMP', logger)).toBe(0.3);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe('assertHeaderSafeApiKeyFormat', () => {
  test('출력 가능 ASCII로만 구성된 키는 통과한다', () => {
    expect(() => assertHeaderSafeApiKeyFormat('AIzaSyValidKey-123_456', 'GEMINI_API_KEY')).not.toThrow();
  });

  test('개행이 섞인 키는 형식 오류로 실패하고 메시지에 원본 키가 포함되지 않는다', () => {
    const key = 'AIzaSy\nFAKE123-not-a-real-secret';
    let caught: unknown;
    try {
      assertHeaderSafeApiKeyFormat(key, 'GEMINI_API_KEY');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain('GEMINI_API_KEY 형식이 올바르지 않습니다');
    expect(message).not.toContain(key);
    expect(message).not.toContain('AIzaSy');
  });

  /**
   * L-9(리뷰 round2, Low, 수정 후): trim은 이 순수 검증 함수 자체가 아니라 실제 호출부
   * (EvaluationModule 팩토리, GeminiLlmEvaluationProvider.evaluate)에서 수행하도록 결정했다
   * (검증과 실제 HTTP 요청에 동일한 trim된 키를 일관되게 사용하기 위함). 따라서 이 순수 함수를
   * 직접 호출하는 단위 테스트는 여전히 trim 없이 그대로 검증하는 것이 맞다 — 공백이 섞인 값을
   * 직접 넘기면 여전히 형식 오류로 실패해야 한다.
   */
  test('L-9: 후행 공백이 섞인 키를 이 함수에 직접 전달하면 trim 없이 그대로 검증되어 형식 오류로 실패한다(의도된 동작)', () => {
    const keyWithTrailingSpace = 'AIzaSyValidKey-123_456 ';
    expect(() => assertHeaderSafeApiKeyFormat(keyWithTrailingSpace, 'GEMINI_API_KEY')).toThrow(
      'GEMINI_API_KEY 형식이 올바르지 않습니다',
    );
  });

  test('L-9: 선행 공백이 섞인 키를 이 함수에 직접 전달해도 동일하게 형식 오류로 실패한다(의도된 동작)', () => {
    const keyWithLeadingSpace = ' AIzaSyValidKey-123_456';
    expect(() => assertHeaderSafeApiKeyFormat(keyWithLeadingSpace, 'GEMINI_API_KEY')).toThrow(
      'GEMINI_API_KEY 형식이 올바르지 않습니다',
    );
  });

  test('빈 문자열은 형식 오류로 실패한다', () => {
    expect(() => assertHeaderSafeApiKeyFormat('', 'GEMINI_API_KEY')).toThrow(
      'GEMINI_API_KEY 형식이 올바르지 않습니다',
    );
  });
});
