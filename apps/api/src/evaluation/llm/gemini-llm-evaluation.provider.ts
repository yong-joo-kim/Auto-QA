import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { detectProfanity } from '@auto-qa/pii-mask';
import {
  LlmEvaluationProvider,
  LlmEvaluationRequest,
  LlmEvaluationResponse,
} from './llm-evaluation-provider.interface';
import { buildGeminiResponseSchema, convertGeminiItemsObjectToArray } from './gemini-schema-builder';
import { buildGeminiSystemInstruction, buildGeminiUserContent } from './gemini-prompt';
import { fetchWithRetry, HttpStatusError, HttpTimeoutError, HttpNetworkError } from './http-retry';
import { assertHeaderSafeApiKeyFormat, parseFloatEnv, parseIntEnv } from './env-utils';

/**
 * Google Gemini 기반 실채점 프로바이더 (FR-1).
 *
 * 공통 규약(FR-9.2, 이후 Anthropic 실구현이 동일 패턴을 따를 것):
 *   동적 스키마로 구조화 출력 요청 → 최소 파싱 → providerMeta 주입 → 검증/보정은 하지 않음
 *   → 실패 시 throw (EvaluationService가 구조 위반=502 / 값 범위 위반=재시도→manual_review /
 *   그 외 throw=500으로 매핑한다. 이 프로바이더는 상태코드를 직접 결정하지 않는다).
 *
 * 모델 선정 근거·스키마 방언 우회 결정: docs/decisions/ADR-001-gemini-llm-provider.md 참조.
 */
const DEFAULT_GEMINI_API_BASE_URL = 'https://generativelanguage.googleapis.com';
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  /** M-4: thinking이 활성일 때 사고 토큰 사용량. 출력 토큰(maxOutputTokens) 예산을 잠식할 수
   * 있으므로 관측성 로그에 별도로 남긴다(ADR-001 D-2 실측 참고). */
  thoughtsTokenCount?: number;
}

@Injectable()
export class GeminiLlmEvaluationProvider implements LlmEvaluationProvider {
  private readonly logger = new Logger(GeminiLlmEvaluationProvider.name);

  constructor(private readonly config: ConfigService) {}

  async evaluate(request: LlmEvaluationRequest): Promise<LlmEvaluationResponse> {
    // L-9: EvaluationModule의 팩토리와 동일하게 trim한다 — 공백 낀 원본 키를 검증만 통과시키고
    // 실제 HTTP 요청(x-goog-api-key 헤더)에 그대로 쓰면 trim의 의미가 없으므로, 이후 검증과
    // 실제 호출에 사용하는 apiKey 변수 모두 이 trim된 값을 참조하도록 통일한다.
    const apiKey = this.config.get<string>('GEMINI_API_KEY')?.trim();
    // L-11: GEMINI_API_KEY/GEMINI_API_BASE_URL과 동일하게 trim한다 — 후행 공백이 섞인 모델명이
    // fail-fast 검증은 통과한 뒤 encodeURIComponent를 거쳐 URL에 %20으로 들어가 런타임 404를
    // 유발할 수 있으므로, 여기서도 EvaluationModule 팩토리와 동일한 값을 참조하도록 통일한다.
    const model = this.config.get<string>('GEMINI_MODEL')?.trim();

    // 방어적 재확인: 정상 경로에서는 EvaluationModule의 팩토리가 기동 시점에 이미 검증했어야
    // 한다(FR-8.1/8.2). 그래도 이 프로바이더가 다른 경로(예: 단위 테스트)로 직접 호출될 수
    // 있으므로 동일한 fail-fast 메시지를 여기서도 보장한다.
    if (!apiKey) {
      throw new Error('LLM_PROVIDER=gemini이지만 GEMINI_API_KEY가 설정되지 않았습니다. .env를 확인하세요.');
    }
    if (!model) {
      throw new Error('LLM_PROVIDER=gemini이지만 GEMINI_MODEL이 설정되지 않았습니다. .env를 확인하세요.');
    }
    // H-1: EvaluationModule의 팩토리가 기동 시점에 이미 검증하지만(위 주석 참조), 이 프로바이더가
    // 팩토리를 거치지 않고 직접 인스턴스화되는 경로(단위 테스트 등)에서도 동일하게 방어한다.
    assertHeaderSafeApiKeyFormat(apiKey, 'GEMINI_API_KEY');

    const baseUrl = this.config.get<string>('GEMINI_API_BASE_URL')?.trim() || DEFAULT_GEMINI_API_BASE_URL;
    const timeoutMs = parseIntEnv(this.config.get<string>('GEMINI_TIMEOUT_MS'), 60000, 'GEMINI_TIMEOUT_MS', this.logger);
    const maxRetries = parseIntEnv(this.config.get<string>('GEMINI_MAX_RETRIES'), 2, 'GEMINI_MAX_RETRIES', this.logger);
    const maxOutputTokens = parseIntEnv(
      this.config.get<string>('GEMINI_MAX_OUTPUT_TOKENS'),
      8192,
      'GEMINI_MAX_OUTPUT_TOKENS',
      this.logger,
    );
    const temperature = parseFloatEnv(this.config.get<string>('GEMINI_TEMPERATURE'), 0, 'GEMINI_TEMPERATURE', this.logger);
    const thinkingBudgetRaw = this.config.get<string>('GEMINI_THINKING_BUDGET');
    const thinkingBudget =
      thinkingBudgetRaw !== undefined && thinkingBudgetRaw.trim() !== '' && Number.isFinite(Number(thinkingBudgetRaw))
        ? Number(thinkingBudgetRaw)
        : undefined;

    const requestBody = {
      systemInstruction: {
        role: 'system',
        parts: [{ text: buildGeminiSystemInstruction(request.evalSheet) }],
      },
      contents: [
        {
          role: 'user',
          parts: [{ text: buildGeminiUserContent(request.evalSheet, request.maskedTranscript) }],
        },
      ],
      generationConfig: {
        temperature,
        maxOutputTokens,
        responseMimeType: 'application/json',
        responseSchema: buildGeminiResponseSchema(request.evalSheet),
        ...(thinkingBudget !== undefined ? { thinkingConfig: { thinkingBudget } } : {}),
      },
    };

    const url = `${baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const startedAt = Date.now();
    let attempts = 0;

    try {
      const { response, attempts: usedAttempts } = await fetchWithRetry(
        url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // NFR-1.2: 키는 헤더로만 전송하고 쿼리스트링에 포함하지 않는다(URL 로그에도 남지 않음).
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify(requestBody),
        },
        {
          timeoutMs,
          maxRetries,
          isRetryableStatus: (status) => RETRYABLE_STATUS_CODES.has(status),
        },
      );
      attempts = usedAttempts;

      // L-10: response.json()을 가드 없이 호출하면 204(No Content) 등 본문이 없는 응답에서
      // Node fetch가 "Unexpected end of JSON input"이라는 불친절한 원시 에러를 던진다.
      // 먼저 text()로 읽어 빈 문자열은 빈 객체로 취급하고(이후 extractGeminiCandidateText가
      // "candidate가 없습니다"라는 명확한 에러로 실패시킨다), 그 외 파싱 실패는 아래
      // JSON.parse(text)와 동일한 패턴으로 모델명을 포함한 친절한 에러 메시지를 던진다.
      const responseBodyText = await response.text();
      let json: unknown;
      try {
        json = responseBodyText ? JSON.parse(responseBodyText) : {};
      } catch {
        throw new Error(`Gemini 응답 본문 JSON 파싱에 실패했습니다 (model=${model})`);
      }
      const { text, finishReason, usage } = extractGeminiCandidateText(json, model);

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`Gemini 응답 JSON 파싱에 실패했습니다 (model=${model})`);
      }

      const latencyMs = Date.now() - startedAt;
      const parsedObj = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};

      // FR-5.2: itemId-key 객체 → items[] 배열로의 형태 변환만 수행한다(값 검증/보정 없음).
      const items = convertGeminiItemsObjectToArray(parsedObj.items, request.evalSheet);
      // FR-6.1: profanityCheck는 Gemini에 요청하지 않고 로컬 detectProfanity 결과를 그대로 사용한다.
      const profanityCheck = detectProfanity(request.maskedTranscript);

      this.logObservability({
        domainId: request.domainId,
        model,
        attempts,
        latencyMs,
        finishReason,
        usage,
      });

      return {
        items,
        coaching: parsedObj.coaching,
        profanityCheck,
        providerMeta: { provider: 'gemini', model, latencyMs },
      } as unknown as LlmEvaluationResponse;
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      // M-2: 실패 시에도 실제로 수행된 시도 횟수를 로그에 남긴다(HttpStatusError/HttpTimeoutError/
      // HttpNetworkError가 attempts를 싣고 있으면 그 값을 우선한다).
      const failedAttempts = extractAttempts(error) ?? (attempts || 1);
      // H-1: 에러 메시지에서 API 키 값을 실제로 치환해 제거한다(개행 등 헤더로 허용되지 않는
      // 문자가 섞인 키가 Node fetch/Headers의 TypeError 메시지에 키 전문을 담아 던져지는
      // 경로에 대한 방어. 기동/호출 시점의 형식 검증이 1차 방어선이고, 이 redaction은
      // 어떤 하위 라이브러리 예외든 안전하게 로깅하기 위한 2차 방어다).
      const safeMessage = toSafeErrorMessage(error, apiKey);
      this.logger.error(
        `Gemini 호출 실패 (domainId=${request.domainId}, model=${model}, attempts=${failedAttempts}, latencyMs=${latencyMs}): ${safeMessage}`,
      );
      // H-1: 원본 에러를 그대로 rethrow하지 않는다 — EvaluationService.invokeProvider가 이
      // 에러를 다시 로그에 남기므로(2차 노출 지점), 정제된 메시지를 담은 새 Error로 감싼다.
      throw new Error(safeMessage);
    }
  }

  private logObservability(entry: {
    domainId: string;
    model: string;
    attempts: number;
    latencyMs: number;
    finishReason: string;
    usage: GeminiUsage;
  }): void {
    // FR-10.1/10.2: 트랜스크립트/프롬프트/응답 본문은 남기지 않고 관측성 메타데이터만 남긴다.
    this.logger.log(
      `Gemini 채점 완료 (provider=gemini, model=${entry.model}, domainId=${entry.domainId}, attempts=${entry.attempts}, latencyMs=${entry.latencyMs}, finishReason=${entry.finishReason}, tokens.in=${entry.usage.promptTokenCount ?? '?'}, tokens.out=${entry.usage.candidatesTokenCount ?? '?'}, tokens.thoughts=${entry.usage.thoughtsTokenCount ?? 0}, tokens.total=${entry.usage.totalTokenCount ?? '?'})`,
    );
  }
}

/**
 * Gemini generateContent 응답에서 텍스트/종료사유/토큰사용량을 추출한다.
 *
 * FR-7.4: 안전 필터 차단, 후보 없음, 비정상 종료(finishReason !== 'STOP')는 깨진 JSON을 억지로
 * 복구하지 않고 명확한 에러로 실패시킨다. 에러 메시지에는 종료 사유 코드·모델명만 포함하고
 * 응답 텍스트는 포함하지 않는다.
 */
function extractGeminiCandidateText(
  json: unknown,
  model: string,
): { text: string; finishReason: string; usage: GeminiUsage } {
  const body = json as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> };
      finishReason?: string;
    }>;
    promptFeedback?: { blockReason?: string };
    usageMetadata?: GeminiUsage;
  };

  const usage: GeminiUsage = body?.usageMetadata ?? {};

  if (body?.promptFeedback?.blockReason && (!body.candidates || body.candidates.length === 0)) {
    throw new Error(
      `Gemini 안전 필터에 의해 요청이 차단되었습니다 (blockReason=${body.promptFeedback.blockReason}, model=${model})`,
    );
  }

  const candidate = body?.candidates?.[0];
  if (!candidate) {
    throw new Error(`Gemini 응답에 candidate가 없습니다 (model=${model})`);
  }

  const finishReason = candidate.finishReason ?? 'UNKNOWN';
  if (finishReason !== 'STOP') {
    throw new Error(`Gemini 응답이 정상 종료되지 않았습니다 (finishReason=${finishReason}, model=${model})`);
  }

  const text = candidate.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
  if (!text) {
    throw new Error(`Gemini 응답에 텍스트 내용이 없습니다 (model=${model})`);
  }

  return { text, finishReason, usage };
}

/**
 * 에러 메시지에서 API 키 값을 실제로 치환해 제거한다(H-1).
 *
 * 키는 헤더로만 전송되므로 정상 경로에서는 메시지에 키가 포함될 일이 없지만, 개행 등
 * 헤더로 허용되지 않는 문자가 섞인 키에 대해 Node `fetch`/`Headers`가 **키 전문을 담은**
 * TypeError를 던지는 사례가 실측되었다(리뷰 H-1). `assertHeaderSafeApiKeyFormat`이 이런
 * 키를 기동/호출 진입부에서 1차로 차단하지만, 이 함수는 그 방어를 우회하는 어떤 하위
 * 라이브러리 예외든 안전하게 로깅하기 위한 2차 방어선이다.
 */
function toSafeErrorMessage(error: unknown, apiKey: string): string {
  const rawMessage =
    error instanceof HttpStatusError
      ? `HttpStatusError: status=${error.status}`
      : error instanceof Error
        ? error.message
        : String(error);
  return redactApiKey(rawMessage, apiKey);
}

/** 메시지에서 apiKey 문자열의 모든 출현을 `[REDACTED]`로 치환한다. */
function redactApiKey(message: string, apiKey: string): string {
  if (!apiKey) return message;
  return message.split(apiKey).join('[REDACTED]');
}

/** M-2: HttpStatusError/HttpTimeoutError/HttpNetworkError가 실어 온 실제 시도 횟수를 추출한다. */
function extractAttempts(error: unknown): number | undefined {
  if (error instanceof HttpStatusError) return error.attempts;
  if (error instanceof HttpTimeoutError) return error.attempts;
  if (error instanceof HttpNetworkError) return error.attempts;
  return undefined;
}
