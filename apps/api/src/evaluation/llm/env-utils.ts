import { Logger } from '@nestjs/common';

/**
 * FR-2.4: 숫자형 env가 비어 있거나 숫자로 파싱되지 않으면 기본값으로 대체하고 경고 로그를 남긴다.
 * (env 값 자체는 비밀이 아니므로 로그에 남겨도 된다.)
 */
export function parseIntEnv(
  rawValue: string | undefined,
  defaultValue: number,
  envName: string,
  logger: Logger,
): number {
  if (rawValue === undefined || rawValue.trim() === '') return defaultValue;
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed)) {
    logger.warn(`${envName}=${rawValue} 값을 정수로 해석할 수 없어 기본값(${defaultValue})을 사용합니다.`);
    return defaultValue;
  }
  return parsed;
}

export function parseFloatEnv(
  rawValue: string | undefined,
  defaultValue: number,
  envName: string,
  logger: Logger,
): number {
  if (rawValue === undefined || rawValue.trim() === '') return defaultValue;
  const parsed = Number.parseFloat(rawValue);
  if (!Number.isFinite(parsed)) {
    logger.warn(`${envName}=${rawValue} 값을 숫자로 해석할 수 없어 기본값(${defaultValue})을 사용합니다.`);
    return defaultValue;
  }
  return parsed;
}

/**
 * H-1: HTTP 헤더 값으로 허용되지 않는 문자(개행/제어문자/비ASCII 등)가 포함된 키를 기동/호출
 * 시점에 걸러낸다. 출력 가능한 ASCII(0x21~0x7e)만 허용한다(공백 포함 금지 — API 키에 공백이
 * 포함될 일은 없다).
 *
 * 이 검증을 통과하지 못하면 Node `fetch`/`Headers`가 키 전문을 담은 TypeError를 던질 수 있고,
 * 그 메시지가 마스킹 없이 로그에 남을 위험이 있다(리뷰 H-1). 값 자체는 에러 메시지에 포함하지
 * 않는다.
 */
const HEADER_SAFE_VALUE_PATTERN = /^[\x21-\x7e]+$/;

export function assertHeaderSafeApiKeyFormat(apiKey: string, envName: string): void {
  if (!HEADER_SAFE_VALUE_PATTERN.test(apiKey)) {
    throw new Error(
      `${envName} 형식이 올바르지 않습니다(개행/공백/제어문자 등 HTTP 헤더로 허용되지 않는 문자가 포함되어 있습니다). ` +
        '.env 값을 다시 확인하세요. (값 자체는 보안을 위해 출력하지 않습니다)',
    );
  }
}
