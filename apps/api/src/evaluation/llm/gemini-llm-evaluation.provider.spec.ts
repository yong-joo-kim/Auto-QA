import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConfigService } from '@nestjs/config';
import { InternalServerErrorException, Logger } from '@nestjs/common';
import { EvalSheet } from '@auto-qa/eval-schema';
import { GeminiLlmEvaluationProvider } from './gemini-llm-evaluation.provider';
import { EvaluationService } from '../evaluation.service';

/**
 * NFR-6.1/AC-3/AC-4/AC-5/AC-7/AC-8: 실제 네트워크·API 키 없이(로컬 스텁 HTTP 서버 +
 * GEMINI_API_BASE_URL 오버라이드) Gemini 프로바이더의 정상/오류 경로를 검증한다.
 *
 * "최소 파싱" 원칙(FR-5.1)에 따라 이 프로바이더는 값 검증/보정을 하지 않으므로, 구조 위반/값
 * 범위 위반 응답도 그대로 통과시키는지만 이 스펙에서 확인한다(502/manual_review 판정 자체는
 * evaluation.service.spec.ts가 이미 검증하는 EvaluationService의 책임).
 */

const FAKE_API_KEY = 'test-fake-gemini-key-not-a-real-secret';

const BASE_SHEET: EvalSheet = {
  domainId: 'test-domain',
  domainName: '테스트 도메인',
  version: '1.0.0',
  totalMaxScore: 20,
  gradeCriteria: [{ minScore: 0, grade: '보통' }],
  categories: [
    {
      categoryId: 'cat-a',
      categoryName: 'A',
      maxScore: 10,
      items: [
        { itemId: 'item-1', itemName: 'Item1', criteria: 'c1', maxScore: 5, gating: false },
        { itemId: 'item-2', itemName: 'Item2', criteria: 'c2', maxScore: 5, gating: false },
      ],
    },
    {
      categoryId: 'cat-b',
      categoryName: 'B',
      maxScore: 10,
      items: [{ itemId: 'item-3', itemName: 'Item3', criteria: 'c3', maxScore: 10, gating: true }],
    },
  ],
};

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

function startStubServer(): { url: string; setHandler: (h: Handler) => void; capturedBodies: string[]; close: () => Promise<void> } {
  let currentHandler: Handler = (_req, res) => {
    res.writeHead(500);
    res.end('no handler set');
  };
  const capturedBodies: string[] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      capturedBodies.push(Buffer.concat(chunks).toString('utf-8'));
      currentHandler(req, res);
    });
  });

  return {
    url: '', // set after listen
    setHandler: (h) => {
      currentHandler = h;
    },
    capturedBodies,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    // @ts-expect-error -- listen 처리를 아래 startServerListening에서 담당
    __server: server,
  };
}

async function createStub() {
  const stub = startStubServer();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server: http.Server = (stub as any).__server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { ...stub, url: `http://127.0.0.1:${port}` };
}

function jsonHandler(status: number, body: unknown): Handler {
  return (_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
}

function createProvider(baseUrl: string, overrides: Record<string, string> = {}): GeminiLlmEvaluationProvider {
  const env: Record<string, string> = {
    GEMINI_API_KEY: FAKE_API_KEY,
    GEMINI_MODEL: 'gemini-test-model',
    GEMINI_API_BASE_URL: baseUrl,
    GEMINI_TIMEOUT_MS: '1000',
    GEMINI_MAX_RETRIES: '1',
    ...overrides,
  };
  const config = { get: (key: string) => env[key] } as unknown as ConfigService;
  return new GeminiLlmEvaluationProvider(config);
}

function successGeminiBody(text: string) {
  return {
    candidates: [{ content: { parts: [{ text }], role: 'model' }, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    modelVersion: 'gemini-test-model',
  };
}

describe('GeminiLlmEvaluationProvider', () => {
  test('AC-1/AC-2 유사: 정상 응답을 items[]/coaching/profanityCheck/providerMeta로 변환한다', async () => {
    const stub = await createStub();
    try {
      stub.setHandler(
        jsonHandler(
          200,
          successGeminiBody(
            JSON.stringify({
              items: {
                'item-1': { score: 4, reason: '충분히 잘 수행함' },
                'item-2': { score: 3, reason: '보통 수준' },
                'item-3': { score: 8, reason: '게이팅 통과', passFail: 'P' },
              },
              coaching: { goodPoints: ['좋았어요'], improvements: ['보완하세요'] },
            }),
          ),
        ),
      );

      const provider = createProvider(stub.url);
      const result = await provider.evaluate({
        domainId: 'test-domain',
        maskedTranscript: '상담사: 안녕하세요. 고객: [전화번호]로 연락드릴게요.',
        evalSheet: BASE_SHEET,
      });

      expect(result.items).toEqual(
        expect.arrayContaining([
          { itemId: 'item-1', score: 4, reason: '충분히 잘 수행함' },
          { itemId: 'item-2', score: 3, reason: '보통 수준' },
          { itemId: 'item-3', score: 8, reason: '게이팅 통과', passFail: 'P' },
        ]),
      );
      expect(result.items).toHaveLength(3);
      expect(result.coaching).toEqual({ goodPoints: ['좋았어요'], improvements: ['보완하세요'] });
      expect(result.providerMeta.provider).toBe('gemini');
      expect(result.providerMeta.model).toBe('gemini-test-model');
      expect(result.providerMeta.latencyMs).toBeGreaterThanOrEqual(0);
      // FR-6.1: profanityCheck는 Gemini가 아니라 로컬 detectProfanity로 산출된다(비속어 없음).
      expect(result.profanityCheck).toEqual({ detected: false, matches: [] });
    } finally {
      await stub.close();
    }
  });

  test('AC-11 유사: 비속어가 포함된 트랜스크립트는 Gemini 응답과 무관하게 로컬 detectProfanity 결과로 profanityCheck가 채워진다', async () => {
    const stub = await createStub();
    try {
      stub.setHandler(
        jsonHandler(
          200,
          successGeminiBody(
            JSON.stringify({
              items: {
                'item-1': { score: 4, reason: 'r1' },
                'item-2': { score: 3, reason: 'r2' },
                'item-3': { score: 8, reason: 'r3', passFail: 'P' },
              },
              coaching: { goodPoints: ['a'], improvements: ['b'] },
              // FR-6.1: Gemini 응답 스키마에서 profanityCheck는 요청하지 않으므로, 모델이 실수로
              // 이 필드를 보내더라도 provider가 무시하고 로컬 산출값으로 덮어써야 한다.
              profanityCheck: { detected: false, matches: [] },
            }),
          ),
        ),
      );

      const provider = createProvider(stub.url);
      const result = await provider.evaluate({
        domainId: 'test-domain',
        maskedTranscript: '고객: 씨발 언제까지 기다려야 해요',
        evalSheet: BASE_SHEET,
      });

      expect(result.profanityCheck.detected).toBe(true);
      expect(result.profanityCheck.matches).toHaveLength(1);
      expect(result.profanityCheck.matches[0].speaker).toBe('customer');
      // AC-11: matches[].maskedText에 비속어 원문이 남지 않는다.
      expect(result.profanityCheck.matches[0].maskedText).not.toContain('씨발');
      expect(result.profanityCheck.matches[0].maskedText).toContain('***');
    } finally {
      await stub.close();
    }
  });

  test('AC-8 유사: 전송된 요청 본문에 마스킹 전 원문 대신 마스킹된 텍스트가 그대로 포함된다', async () => {
    const stub = await createStub();
    try {
      stub.setHandler(
        jsonHandler(
          200,
          successGeminiBody(
            JSON.stringify({
              items: {
                'item-1': { score: 1, reason: 'x' },
                'item-2': { score: 1, reason: 'x' },
                'item-3': { score: 1, reason: 'x', passFail: 'F' },
              },
              coaching: { goodPoints: ['a'], improvements: ['b'] },
            }),
          ),
        ),
      );

      const provider = createProvider(stub.url);
      const maskedTranscript = '상담사: 고객님 전화번호는 [전화번호] 입니다.';
      await provider.evaluate({ domainId: 'test-domain', maskedTranscript, evalSheet: BASE_SHEET });

      const sentBody = stub.capturedBodies[0];
      expect(sentBody).toContain('[전화번호]');
      expect(sentBody).not.toContain(FAKE_API_KEY);
    } finally {
      await stub.close();
    }
  });

  test('AC-3 유사(구조 위반 passthrough): 항목 하나가 응답에서 누락되어도 프로바이더가 채워넣지 않는다(FR-5.3)', async () => {
    const stub = await createStub();
    try {
      stub.setHandler(
        jsonHandler(
          200,
          successGeminiBody(
            JSON.stringify({
              items: {
                'item-1': { score: 4, reason: 'r1' },
                // item-2, item-3 누락
              },
              coaching: { goodPoints: ['a'], improvements: ['b'] },
            }),
          ),
        ),
      );

      const provider = createProvider(stub.url);
      const result = await provider.evaluate({
        domainId: 'test-domain',
        maskedTranscript: '대화',
        evalSheet: BASE_SHEET,
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].itemId).toBe('item-1');
    } finally {
      await stub.close();
    }
  });

  test('AC-4 유사(값 범위 위반 passthrough): 배점 초과 score를 clamp하지 않고 그대로 전달한다(FR-5.4)', async () => {
    const stub = await createStub();
    try {
      stub.setHandler(
        jsonHandler(
          200,
          successGeminiBody(
            JSON.stringify({
              items: {
                'item-1': { score: 999, reason: 'r1' },
                'item-2': { score: 3, reason: 'r2' },
                'item-3': { score: 8, reason: 'r3', passFail: 'P' },
              },
              coaching: { goodPoints: ['a'], improvements: ['b'] },
            }),
          ),
        ),
      );

      const provider = createProvider(stub.url);
      const result = await provider.evaluate({
        domainId: 'test-domain',
        maskedTranscript: '대화',
        evalSheet: BASE_SHEET,
      });

      const item1 = result.items.find((i) => i.itemId === 'item-1');
      expect(item1?.score).toBe(999); // clamp하지 않음 — EvaluationService가 재시도/보정 담당
    } finally {
      await stub.close();
    }
  });

  test('AC-5 유사: 429가 재시도 소진까지 지속되면 throw한다', async () => {
    const stub = await createStub();
    try {
      stub.setHandler(jsonHandler(429, { error: { code: 429, message: 'rate limited' } }));

      const provider = createProvider(stub.url, { GEMINI_MAX_RETRIES: '1' });
      await expect(
        provider.evaluate({ domainId: 'test-domain', maskedTranscript: '대화', evalSheet: BASE_SHEET }),
      ).rejects.toThrow();
    } finally {
      await stub.close();
    }
  });

  test('AC-5 유사: 503이 재시도 소진까지 지속되면 throw한다', async () => {
    const stub = await createStub();
    try {
      stub.setHandler(jsonHandler(503, { error: { code: 503, message: 'unavailable' } }));

      const provider = createProvider(stub.url, { GEMINI_MAX_RETRIES: '1' });
      await expect(
        provider.evaluate({ domainId: 'test-domain', maskedTranscript: '대화', evalSheet: BASE_SHEET }),
      ).rejects.toThrow();
    } finally {
      await stub.close();
    }
  });

  test('AC-5 유사: 400(영구적 오류)은 재시도 없이 즉시 실패한다', async () => {
    const stub = await createStub();
    let callCount = 0;
    try {
      stub.setHandler((_req, res) => {
        callCount++;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 400, message: 'bad request' } }));
      });

      const provider = createProvider(stub.url, { GEMINI_MAX_RETRIES: '2' });
      await expect(
        provider.evaluate({ domainId: 'test-domain', maskedTranscript: '대화', evalSheet: BASE_SHEET }),
      ).rejects.toThrow();
      expect(callCount).toBe(1);
    } finally {
      await stub.close();
    }
  });

  test('AC-5 유사: 응답하지 않는 서버는 GEMINI_TIMEOUT_MS 경과 후 확실히 중단된다', async () => {
    const stub = await createStub();
    try {
      stub.setHandler(() => {
        // 응답하지 않음 → 타임아웃 유도
      });

      const provider = createProvider(stub.url, { GEMINI_TIMEOUT_MS: '200', GEMINI_MAX_RETRIES: '0' });
      const start = Date.now();
      await expect(
        provider.evaluate({ domainId: 'test-domain', maskedTranscript: '대화', evalSheet: BASE_SHEET }),
      ).rejects.toThrow();
      expect(Date.now() - start).toBeLessThan(3000);
    } finally {
      await stub.close();
    }
  });

  test('AC-5 유사: 안전 필터 차단(promptFeedback.blockReason)은 즉시 실패하고 응답 텍스트를 복구하지 않는다', async () => {
    const stub = await createStub();
    try {
      stub.setHandler(jsonHandler(200, { candidates: [], promptFeedback: { blockReason: 'SAFETY' } }));

      const provider = createProvider(stub.url);
      await expect(
        provider.evaluate({ domainId: 'test-domain', maskedTranscript: '대화', evalSheet: BASE_SHEET }),
      ).rejects.toThrow(/SAFETY/);
    } finally {
      await stub.close();
    }
  });

  test('AC-5 유사: 응답이 MAX_TOKENS로 잘리면(finishReason !== STOP) 억지로 복구하지 않고 실패한다', async () => {
    const stub = await createStub();
    try {
      stub.setHandler(
        jsonHandler(200, {
          candidates: [
            {
              content: { parts: [{ text: '{"items": {' }], role: 'model' },
              finishReason: 'MAX_TOKENS',
              index: 0,
            },
          ],
        }),
      );

      const provider = createProvider(stub.url);
      await expect(
        provider.evaluate({ domainId: 'test-domain', maskedTranscript: '대화', evalSheet: BASE_SHEET }),
      ).rejects.toThrow(/MAX_TOKENS/);
    } finally {
      await stub.close();
    }
  });

  test('AC-5 유사: JSON 파싱 실패 시 명확한 에러로 실패한다', async () => {
    const stub = await createStub();
    try {
      stub.setHandler(jsonHandler(200, successGeminiBody('이것은 JSON이 아닙니다')));

      const provider = createProvider(stub.url);
      await expect(
        provider.evaluate({ domainId: 'test-domain', maskedTranscript: '대화', evalSheet: BASE_SHEET }),
      ).rejects.toThrow(/파싱/);
    } finally {
      await stub.close();
    }
  });

  test('AC-6 유사: GEMINI_API_KEY가 없으면 evaluate 호출 시 한국어 오류로 즉시 실패한다(키 값 노출 없음)', async () => {
    const config = { get: () => undefined } as unknown as ConfigService;
    const provider = new GeminiLlmEvaluationProvider(config);
    await expect(
      provider.evaluate({ domainId: 'test-domain', maskedTranscript: '대화', evalSheet: BASE_SHEET }),
    ).rejects.toThrow('GEMINI_API_KEY가 설정되지 않았습니다');
  });

  test('AC-6 유사: GEMINI_MODEL이 없으면 evaluate 호출 시 한국어 오류로 즉시 실패한다', async () => {
    const env: Record<string, string> = { GEMINI_API_KEY: FAKE_API_KEY };
    const config = { get: (key: string) => env[key] } as unknown as ConfigService;
    const provider = new GeminiLlmEvaluationProvider(config);
    await expect(
      provider.evaluate({ domainId: 'test-domain', maskedTranscript: '대화', evalSheet: BASE_SHEET }),
    ).rejects.toThrow('GEMINI_MODEL이 설정되지 않았습니다');
  });

  describe('H-1: GEMINI_API_KEY 비노출', () => {
    test('개행이 섞인 GEMINI_API_KEY는 네트워크 호출 전에 형식 오류로 즉시 실패하고, 오류 메시지에 키 값이 전혀 포함되지 않는다', async () => {
      // 리뷰가 실측한 트리거: 키 중간에 개행이 섞이면 Node fetch/Headers가 키 전문을 담은
      // TypeError를 던진다. 이 테스트는 그 지점에 도달하기 전에(호출 진입부에서) 형식
      // 검증으로 차단되는지, 그리고 에러 메시지에 키의 어떤 부분 문자열도 남지 않는지 확인한다.
      const maliciousKey = 'AIzaSy\nFAKE123-not-a-real-secret';
      const env: Record<string, string> = { GEMINI_API_KEY: maliciousKey, GEMINI_MODEL: 'gemini-test-model' };
      const config = { get: (key: string) => env[key] } as unknown as ConfigService;
      const provider = new GeminiLlmEvaluationProvider(config);

      let caught: unknown;
      try {
        await provider.evaluate({ domainId: 'test-domain', maskedTranscript: '대화', evalSheet: BASE_SHEET });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message).toContain('GEMINI_API_KEY 형식이 올바르지 않습니다');
      expect(message).not.toContain('AIzaSy');
      expect(message).not.toContain('FAKE123');
      expect(message).not.toContain(maliciousKey);
    });

    test('U+200B 등 비-ASCII 문자가 섞인 GEMINI_API_KEY도 형식 오류로 즉시 실패한다', async () => {
      const maliciousKey = 'AIzaSy​FAKE123';
      const env: Record<string, string> = { GEMINI_API_KEY: maliciousKey, GEMINI_MODEL: 'gemini-test-model' };
      const config = { get: (key: string) => env[key] } as unknown as ConfigService;
      const provider = new GeminiLlmEvaluationProvider(config);

      await expect(
        provider.evaluate({ domainId: 'test-domain', maskedTranscript: '대화', evalSheet: BASE_SHEET }),
      ).rejects.toThrow('GEMINI_API_KEY 형식이 올바르지 않습니다');
    });

    test('형식은 올바르지만 하위 네트워크 오류 메시지에 키 전문이 실려 있어도 redaction되어 노출되지 않는다(2차 방어)', async () => {
      // assertHeaderSafeApiKeyFormat을 통과하는(형식은 정상인) 키를 사용하되, fetch 자체를
      // 모킹해 "하위 라이브러리가 어떤 이유로든 키를 메시지에 실어 던지는" 시나리오를
      // 인위적으로 재현한다. toSafeErrorMessage의 실제 치환 로직을 검증하기 위함이다.
      const originalFetch = global.fetch;
      const leakyMessage = `Headers.append: "${FAKE_API_KEY}" is an invalid header value.`;
      global.fetch = jest.fn().mockRejectedValue(new TypeError(leakyMessage)) as unknown as typeof fetch;

      try {
        const provider = createProvider('http://127.0.0.1:1', { GEMINI_MAX_RETRIES: '0' });
        let caught: unknown;
        try {
          await provider.evaluate({ domainId: 'test-domain', maskedTranscript: '대화', evalSheet: BASE_SHEET });
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(Error);
        const message = (caught as Error).message;
        expect(message).not.toContain(FAKE_API_KEY);
        expect(message).toContain('[REDACTED]');
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('evaluation.service.ts 재로깅 경로에서도 원본(비-redaction) 메시지가 새지 않는다(2중 노출 방지)', async () => {
      // 프로바이더가 던지는 에러 자체가 이미 redaction된 새 Error이므로, 이를 그대로
      // 재로깅하는 상위 호출자(EvaluationService.invokeProvider)도 안전해야 한다.
      const originalFetch = global.fetch;
      const leakyMessage = `Headers.append: "${FAKE_API_KEY}" is an invalid header value.`;
      global.fetch = jest.fn().mockRejectedValue(new TypeError(leakyMessage)) as unknown as typeof fetch;

      try {
        const provider = createProvider('http://127.0.0.1:1', { GEMINI_MAX_RETRIES: '0' });
        let caught: unknown;
        try {
          await provider.evaluate({ domainId: 'test-domain', maskedTranscript: '대화', evalSheet: BASE_SHEET });
        } catch (err) {
          caught = err;
        }
        // EvaluationService.invokeProvider가 하는 것과 동일하게 error.message를 다시 사용해도
        // 키가 노출되지 않아야 한다(2중 로깅 방어).
        const rerenderedLog = `LLM 채점 요청 실패: ${(caught as Error).message}`;
        expect(rerenderedLog).not.toContain(FAKE_API_KEY);
      } finally {
        global.fetch = originalFetch;
      }
    });
  });

  describe('AC-9: 결정론성 비적용 확인', () => {
    /**
     * NFR-5/AC-9: 동일 입력을 2회 채점했을 때 결과가 완전히 동일하지 않아도 실패로 간주하지
     * 않는다. 이 테스트는 두 차례 호출이 서로 다른(비결정적인 LLM 응답을 흉내낸) 점수를
     * 반환하더라도, 프로바이더가 값을 비교·검증·강제 일치시키려 하지 않고 각각을 독립적으로
     * 그대로 전달함을 고정한다(계약 준수 여부만 관찰 대상 — 값의 동일성은 검증하지 않음).
     */
    test('동일 입력에 서로 다른 점수를 반환하는 두 응답이 각각 오류 없이 처리되고, 관찰된 총점 차이를 기록한다', async () => {
      const stub = await createStub();
      try {
        const responseFor = (score1: number, score2: number, score3: number) =>
          jsonHandler(
            200,
            successGeminiBody(
              JSON.stringify({
                items: {
                  'item-1': { score: score1, reason: '1차 관찰' },
                  'item-2': { score: score2, reason: '2차 관찰' },
                  'item-3': { score: score3, reason: '게이팅 관찰', passFail: score3 >= 5 ? 'P' : 'F' },
                },
                coaching: { goodPoints: ['a'], improvements: ['b'] },
              }),
            ),
          );

        stub.setHandler(responseFor(4, 3, 8));
        const provider = createProvider(stub.url);
        const first = await provider.evaluate({
          domainId: 'test-domain',
          maskedTranscript: '동일한 대화 내용',
          evalSheet: BASE_SHEET,
        });

        stub.setHandler(responseFor(5, 2, 6));
        const second = await provider.evaluate({
          domainId: 'test-domain',
          maskedTranscript: '동일한 대화 내용',
          evalSheet: BASE_SHEET,
        });

        const totalOf = (r: typeof first) => r.items.reduce((sum, i) => sum + (i.score as number), 0);
        const firstTotal = totalOf(first);
        const secondTotal = totalOf(second);

        // 두 결과가 다를 수 있음을 허용한다(완전 동일을 요구하지 않음 — Phase 1 AC-8은 mock 전용).
        // 관찰값 기록(리포트 §참조): firstTotal=15, secondTotal=13, 차이=2.
        expect(firstTotal).toBe(15);
        expect(secondTotal).toBe(13);
        expect(firstTotal).not.toBe(secondTotal);

        // 값이 다르더라도 둘 다 AC-2(항목 완전성)를 충족해야 한다 — 이 프로바이더 레벨에서는
        // "몇 개 항목이 왔는지"만 확인하고, 배점 상한/범위 검증은 EvaluationService의 책임이다.
        expect(first.items).toHaveLength(3);
        expect(second.items).toHaveLength(3);
      } finally {
        await stub.close();
      }
    });
  });

  describe('AC-12: 관측성 로그', () => {
    test('성공 시 provider/model/domainId/attempts/latencyMs/finishReason/토큰 사용량이 로그에 남고 트랜스크립트·응답 본문은 남지 않는다', async () => {
      const stub = await createStub();
      const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      try {
        const secretReason = '이 사유 문구는 로그에 노출되면 안 되는 응답 본문 텍스트다';
        const secretTranscript = '상담사: 이 트랜스크립트 문장도 로그에 노출되면 안 된다.';
        stub.setHandler(
          jsonHandler(
            200,
            successGeminiBody(
              JSON.stringify({
                items: {
                  'item-1': { score: 4, reason: secretReason },
                  'item-2': { score: 3, reason: 'x' },
                  'item-3': { score: 8, reason: 'x', passFail: 'P' },
                },
                coaching: { goodPoints: ['a'], improvements: ['b'] },
              }),
            ),
          ),
        );

        const provider = createProvider(stub.url);
        await provider.evaluate({
          domainId: 'ac12-domain',
          maskedTranscript: secretTranscript,
          evalSheet: BASE_SHEET,
        });

        const logged = logSpy.mock.calls.map((args) => String(args[0]));
        const successLine = logged.find((m) => m.includes('Gemini 채점 완료'));
        expect(successLine).toBeDefined();
        expect(successLine).toContain('provider=gemini');
        expect(successLine).toContain('model=gemini-test-model');
        expect(successLine).toContain('domainId=ac12-domain');
        expect(successLine).toContain('attempts=1');
        expect(successLine).toMatch(/latencyMs=\d+/);
        expect(successLine).toContain('finishReason=STOP');
        expect(successLine).toContain('tokens.in=10');
        expect(successLine).toContain('tokens.out=5');
        expect(successLine).toContain('tokens.total=15');
        expect(successLine).toContain('tokens.thoughts=0');

        // FR-10.2: 트랜스크립트 원문/사유 본문이 관측성 로그 어디에도 남지 않는다.
        for (const line of logged) {
          expect(line).not.toContain(secretTranscript);
          expect(line).not.toContain(secretReason);
        }
      } finally {
        logSpy.mockRestore();
        await stub.close();
      }
    });
  });

  describe('M-2: 실패 로그의 실제 시도 횟수', () => {
    test('429가 재시도 소진까지 지속되면 실패 로그에 실제 시도 횟수(초회+재시도)가 기록된다', async () => {
      const stub = await createStub();
      const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        stub.setHandler(jsonHandler(429, { error: { code: 429, message: 'rate limited' } }));

        const provider = createProvider(stub.url, { GEMINI_MAX_RETRIES: '2' });
        await expect(
          provider.evaluate({ domainId: 'test-domain', maskedTranscript: '대화', evalSheet: BASE_SHEET }),
        ).rejects.toThrow();

        const loggedMessages = errorSpy.mock.calls.map((args) => String(args[0]));
        // 최초 1회 + 재시도 2회 = 총 3회 시도가 로그에 정확히 남아야 한다(이전 버그는 항상 1로 고정).
        expect(loggedMessages.some((m) => m.includes('attempts=3'))).toBe(true);
      } finally {
        errorSpy.mockRestore();
        await stub.close();
      }
    });
  });

  describe('L-12(리뷰 round2 재발견, Low): GEMINI_API_KEY trim이 실제 HTTP 요청 헤더에 반영된다', () => {
    /**
     * L-9/L-12: evaluate()가 GEMINI_API_KEY를 trim해 fail-fast 검증(assertHeaderSafeApiKeyFormat)을
     * 통과시키는 것까지는 기존 evaluation.module.spec.ts(모듈 부팅 성공)로 고정되어 있었지만,
     * "실제로 trim된 값이 x-goog-api-key 헤더에 그대로 실리는지"를 직접 단언하는 테스트가 없었다
     * (검증만 통과하고 원본 공백 낀 키를 그대로 전송했다면 헤더 값 자체가 잘못된 채로 새어나갈 수
     * 있다 — assertHeaderSafeApiKeyFormat은 공백 문자를 거부하므로, trim 없이는 애초에 이 지점까지
     * 도달하지 못하고 evaluate()가 형식 오류로 실패했을 것이다). 로컬 스텁 서버가 실제로 수신한
     * 헤더 값을 캡처해 trim된 키와 정확히 일치함을 고정한다.
     */
    test('앞뒤 공백이 섞인 GEMINI_API_KEY가 trim되어 x-goog-api-key 헤더에 공백 없이 그대로 전달된다', async () => {
      const stub = await createStub();
      let capturedHeader: string | string[] | undefined;
      try {
        stub.setHandler((req, res) => {
          capturedHeader = req.headers['x-goog-api-key'];
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify(
              successGeminiBody(
                JSON.stringify({
                  items: {
                    'item-1': { score: 1, reason: 'x' },
                    'item-2': { score: 1, reason: 'x' },
                    'item-3': { score: 1, reason: 'x', passFail: 'P' },
                  },
                  coaching: { goodPoints: ['a'], improvements: ['b'] },
                }),
              ),
            ),
          );
        });

        const keyWithWhitespace = `  ${FAKE_API_KEY}  `;
        const provider = createProvider(stub.url, { GEMINI_API_KEY: keyWithWhitespace });
        await provider.evaluate({ domainId: 'test-domain', maskedTranscript: '대화', evalSheet: BASE_SHEET });

        expect(capturedHeader).toBe(FAKE_API_KEY);
        expect(capturedHeader).not.toContain(' ');
      } finally {
        await stub.close();
      }
    });
  });

  describe('L-11(리뷰 round2 재발견, Low): GEMINI_MODEL trim', () => {
    test('앞뒤 공백이 섞인 GEMINI_MODEL이 trim되어 fail-fast를 통과하고, 요청 URL에 %20 없이 정확한 모델명으로 들어간다', async () => {
      const stub = await createStub();
      let capturedUrl: string | undefined;
      try {
        stub.setHandler((req, res) => {
          capturedUrl = req.url;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify(
              successGeminiBody(
                JSON.stringify({
                  items: {
                    'item-1': { score: 1, reason: 'x' },
                    'item-2': { score: 1, reason: 'x' },
                    'item-3': { score: 1, reason: 'x', passFail: 'P' },
                  },
                  coaching: { goodPoints: ['a'], improvements: ['b'] },
                }),
              ),
            ),
          );
        });

        const provider = createProvider(stub.url, { GEMINI_MODEL: '  gemini-test-model  ' });
        const result = await provider.evaluate({
          domainId: 'test-domain',
          maskedTranscript: '대화',
          evalSheet: BASE_SHEET,
        });

        expect(result.providerMeta.model).toBe('gemini-test-model');
        expect(capturedUrl).toBe('/v1beta/models/gemini-test-model:generateContent');
        expect(capturedUrl).not.toContain('%20');
      } finally {
        await stub.close();
      }
    });

    test('공백만 있는 GEMINI_MODEL은 trim 후 빈 문자열이 되어 기존 fail-fast 메시지("GEMINI_MODEL이 설정되지 않았습니다")로 실패한다', async () => {
      const env: Record<string, string> = { GEMINI_API_KEY: FAKE_API_KEY, GEMINI_MODEL: '   ' };
      const config = { get: (key: string) => env[key] } as unknown as ConfigService;
      const provider = new GeminiLlmEvaluationProvider(config);

      await expect(
        provider.evaluate({ domainId: 'test-domain', maskedTranscript: '대화', evalSheet: BASE_SHEET }),
      ).rejects.toThrow('GEMINI_MODEL이 설정되지 않았습니다');
    });
  });

  describe('L-10(리뷰 round2 재발견, Low): 빈 본문(204)/비-JSON 응답 본문의 에러 메시지 개선', () => {
    test('204(빈 본문) 응답은 원시 "Unexpected end of JSON input" 대신 candidate 없음 에러로 실패한다', async () => {
      const stub = await createStub();
      try {
        stub.setHandler((_req, res) => {
          res.writeHead(204, {});
          res.end();
        });

        const provider = createProvider(stub.url);
        let caught: unknown;
        try {
          await provider.evaluate({ domainId: 'test-domain', maskedTranscript: '대화', evalSheet: BASE_SHEET });
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(Error);
        const message = (caught as Error).message;
        expect(message).toContain('Gemini 응답에 candidate가 없습니다');
        expect(message).not.toContain('Unexpected end of JSON input');
      } finally {
        await stub.close();
      }
    });

    test('본문 자체가 JSON이 아니면(파싱 실패) "Gemini 응답 본문 JSON 파싱에 실패했습니다" 메시지로 실패한다', async () => {
      const stub = await createStub();
      try {
        stub.setHandler((_req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('이것은 JSON이 아닌 본문입니다 {');
        });

        const provider = createProvider(stub.url);
        await expect(
          provider.evaluate({ domainId: 'test-domain', maskedTranscript: '대화', evalSheet: BASE_SHEET }),
        ).rejects.toThrow('Gemini 응답 본문 JSON 파싱에 실패했습니다');
      } finally {
        await stub.close();
      }
    });

    test('통합: 204 응답이면 EvaluationService는 원시 파싱 에러를 노출하지 않고 안전한 500(InternalServerErrorException)으로 매핑한다', async () => {
      // invokeProvider는 llmProvider.evaluate()가 던지는 어떤 에러든 그대로 재시도 없이 즉시
      // InternalServerErrorException(500)으로 감싼다 — L-10이 개선한 "candidate가 없습니다" 같은
      // 친절한 메시지조차 최종 사용자에게는 노출되지 않고 고정된 안내 문구로 대체됨을 함께 고정한다.
      const stub = await createStub();
      try {
        stub.setHandler((_req, res) => {
          res.writeHead(204, {});
          res.end();
        });

        const provider = createProvider(stub.url);
        const service = new EvaluationService(provider);

        let caught: unknown;
        try {
          await service.evaluateAndAggregate('test-domain', '대화', BASE_SHEET);
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(InternalServerErrorException);
        expect((caught as InternalServerErrorException).getStatus()).toBe(500);
        const message = (caught as Error).message;
        expect(message).toBe('LLM 채점 요청 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.');
        expect(message).not.toContain('Unexpected end of JSON input');
        expect(message).not.toContain('candidate');
      } finally {
        await stub.close();
      }
    });
  });
});
