/**
 * 프로바이더 간 재사용 가능한 HTTP 재시도/타임아웃 헬퍼(FR-9.1).
 *
 * Gemini 프로바이더가 최초로 사용하며, 이후 Anthropic 실구현이 동일한 재시도/타임아웃/
 * 에러 분류 정책을 복붙 없이 재사용할 수 있도록 이 파일에 로직을 모아둔다.
 *
 * 정책(FR-7):
 *  - 모든 호출에 타임아웃을 적용한다(AbortController).
 *  - 일시적 오류(429, 5xx, 네트워크 단절, 타임아웃)는 최대 maxRetries회, 지수 백오프 + 지터로
 *    재시도한다. 서버가 Retry-After를 주면 우선 존중한다.
 *  - 영구적 오류(그 외 상태코드)는 재시도하지 않고 즉시 throw한다.
 */

export interface HttpRetryOptions {
  timeoutMs: number;
  maxRetries: number;
  /** 이 상태 코드가 true를 반환하면 일시적 오류로 간주해 재시도한다. */
  isRetryableStatus: (status: number) => boolean;
  /**
   * 테스트에서 백오프 지연을 0에 가깝게 만들기 위한 오버라이드 포인트.
   * H-2: `null`을 반환하면 "재시도를 포기하고 즉시 실패"를 의미한다(예: 서버가 보낸
   * `Retry-After` 힌트가 상한을 초과하는 경우).
   */
  computeBackoffMs?: (attempt: number, retryAfterHeader: string | null) => number | null;
}

export class HttpStatusError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    /** M-2: 이 실패가 발생하기까지 실제로 수행된 시도 횟수(1부터 시작). */
    public readonly attempts: number,
  ) {
    super(message);
    this.name = 'HttpStatusError';
  }
}

export class HttpTimeoutError extends Error {
  constructor(
    message: string,
    /** M-2: 이 실패가 발생하기까지 실제로 수행된 시도 횟수(1부터 시작). */
    public readonly attempts: number,
  ) {
    super(message);
    this.name = 'HttpTimeoutError';
  }
}

/** M-2: 네트워크 단절 등 상태코드/타임아웃이 아닌 오류에도 실제 시도 횟수를 실어 전달한다. */
export class HttpNetworkError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'HttpNetworkError';
  }
}

export interface HttpRetryResult {
  response: Response;
  /** 최종 성공까지 소요된 시도 횟수(1부터 시작, 재시도 포함) */
  attempts: number;
}

/**
 * L-8: `Response` 생성자가 body 유무와 무관하게 거부하는 null-body 상태 코드.
 * 204/205만 `response.ok`(2xx) 범위에 속해 버퍼링 재구성 분기에 도달할 수 있다(304는
 * `response.ok`가 false라 이 분기 자체를 타지 않는다). 방어적으로 함께 등재해둔다.
 */
const NULL_BODY_STATUS_CODES = new Set([204, 205, 304]);

/**
 * fetch를 재시도/타임아웃 정책과 함께 실행한다.
 * 반환값의 response는 항상 `response.ok === true`다(그 외에는 throw).
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: HttpRetryOptions,
): Promise<HttpRetryResult> {
  const computeBackoff = options.computeBackoffMs ?? defaultBackoffMs;
  const totalAttempts = options.maxRetries + 1;
  let lastError: unknown;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      const response = await fetch(url, { ...init, signal: controller.signal });

      if (response.ok) {
        // L-8(리뷰 round2): 204/205처럼 본문을 가질 수 없는("null body") 상태 코드는
        // `new Response(body, { status })`가 body 유무와 무관하게 TypeError를 던진다.
        // 이런 상태 코드는 애초에 본문이 없으므로 버퍼링(M-1)이 필요 없다 — 원본 응답을
        // 그대로 반환한다(재구성을 건너뛰므로 TypeError로 인한 재시도 오분류도 사라진다).
        if (NULL_BODY_STATUS_CODES.has(response.status)) {
          clearTimeout(timer);
          return { response, attempts: attempt };
        }

        // M-1: 타임아웃이 응답 헤더 수신까지만 적용되고 본문 수신 구간은 보호되지 않으면,
        // 서버가 헤더만 보내고 본문을 흘리지 않는 경우 GEMINI_TIMEOUT_MS를 넘어 무한정
        // 대기할 수 있다. 본문을 전부 읽을 때까지 타이머를 유지한 뒤 해제한다. 이미 소비한
        // 본문은 새 Response로 재구성해 호출자가 기존과 동일하게 `response.json()`/
        // `response.text()`를 사용할 수 있게 한다(본문을 다시 네트워크에서 읽지 않음).
        const bodyText = await response.text();
        clearTimeout(timer);
        const bufferedResponse = new Response(bodyText, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
        return { response: bufferedResponse, attempts: attempt };
      }

      clearTimeout(timer);

      const retryable = options.isRetryableStatus(response.status);
      if (!retryable || attempt >= totalAttempts) {
        throw new HttpStatusError(`HTTP ${response.status}`, response.status, attempt);
      }

      const delayMs = computeBackoff(attempt, response.headers.get('retry-after'));
      if (delayMs === null) {
        // H-2: Retry-After 힌트가 상한을 초과하면 재시도를 포기하고 즉시 실패한다(무제한 지연 방지).
        throw new HttpStatusError(
          `HTTP ${response.status} (Retry-After 상한을 초과하여 재시도를 포기합니다)`,
          response.status,
          attempt,
        );
      }
      await sleep(delayMs);
      continue;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof HttpStatusError) throw err;

      // Node의 fetch가 타임아웃 시 던지는 abort 예외는 DOMException으로, 런타임/버전에 따라
      // `Error`를 상속하지 않을 수 있다. `instanceof Error` 여부와 무관하게 `name` 속성만으로
      // 판별한다.
      const isAbort = (err as { name?: string })?.name === 'AbortError';
      const wrapped = isAbort
        ? new HttpTimeoutError(`요청이 타임아웃되었습니다(${options.timeoutMs}ms)`, attempt)
        : new HttpNetworkError(err instanceof Error ? err.message : String(err), attempt, err);

      if (attempt >= totalAttempts) throw wrapped;

      lastError = wrapped;
      const delayMs = computeBackoff(attempt, null);
      // 네트워크 오류의 백오프는 Retry-After 힌트가 없으므로(null 전달) computeBackoff가
      // null을 반환하지 않는다(defaultBackoffMs 계약). 방어적으로 null이면 즉시 포기한다.
      if (delayMs === null) throw wrapped;
      await sleep(delayMs);
      continue;
    }
  }

  // 도달하지 않아야 하나, 방어적으로 마지막 오류를 던진다.
  throw lastError instanceof Error ? lastError : new Error('HTTP 요청이 반복 실패했습니다.');
}

/**
 * H-2: 서버가 보낸 `Retry-After` 힌트에도 상한(20초)을 적용한다. 힌트가 상한을 초과하면
 * `null`을 반환해 호출자가 재시도를 포기하고 즉시 실패하도록 한다(단일 채점 요청이
 * `Retry-After: 3600`처럼 무제한 지연되는 것을 방지 — FR-7.7/NFR-4.1).
 */
const RETRY_AFTER_CAP_MS = 20_000;

function defaultBackoffMs(attempt: number, retryAfterHeader: string | null): number | null {
  if (retryAfterHeader) {
    const hintMs = parseRetryAfterMs(retryAfterHeader);
    if (hintMs !== null) {
      return hintMs > RETRY_AFTER_CAP_MS ? null : hintMs;
    }
  }
  const base = 500 * 2 ** (attempt - 1);
  const jitter = Math.random() * 250;
  return Math.min(base + jitter, 8000);
}

/** `Retry-After` 헤더(초 단위 정수 또는 HTTP-date)를 ms로 파싱한다. 해석 불가능하면 null. */
function parseRetryAfterMs(retryAfterHeader: string): number | null {
  const asSeconds = Number(retryAfterHeader);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return asSeconds * 1000;
  const asDate = Date.parse(retryAfterHeader);
  if (!Number.isNaN(asDate)) {
    const delta = asDate - Date.now();
    if (delta > 0) return delta;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
