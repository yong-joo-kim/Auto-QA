import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchWithRetry, HttpStatusError, HttpTimeoutError } from './http-retry';

/**
 * NFR-6.1: 실제 네트워크 없이(로컬 스텁 HTTP 서버) 재시도/타임아웃/백오프 정책을 검증한다.
 * 테스트를 빠르게 하기 위해 computeBackoffMs를 0에 가깝게 오버라이드한다.
 */
const NO_DELAY = () => 0;

function startServer(handler: http.RequestListener): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

describe('fetchWithRetry', () => {
  test('첫 시도가 200이면 재시도 없이 즉시 반환한다', async () => {
    let callCount = 0;
    const { url, close } = await startServer((req, res) => {
      callCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    try {
      const { response, attempts } = await fetchWithRetry(
        url,
        { method: 'GET' },
        { timeoutMs: 2000, maxRetries: 2, isRetryableStatus: (s) => s >= 500, computeBackoffMs: NO_DELAY },
      );
      expect(response.ok).toBe(true);
      expect(attempts).toBe(1);
      expect(callCount).toBe(1);
    } finally {
      await close();
    }
  });

  test('429(재시도 가능)가 2회 발생 후 성공하면 총 3회 시도로 응답을 반환한다', async () => {
    let callCount = 0;
    const { url, close } = await startServer((req, res) => {
      callCount++;
      if (callCount <= 2) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'rate limited' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    try {
      const { response, attempts } = await fetchWithRetry(
        url,
        { method: 'GET' },
        { timeoutMs: 2000, maxRetries: 2, isRetryableStatus: (s) => [429, 500, 502, 503, 504].includes(s), computeBackoffMs: NO_DELAY },
      );
      expect(response.ok).toBe(true);
      expect(attempts).toBe(3);
      expect(callCount).toBe(3);
    } finally {
      await close();
    }
  });

  test('503이 재시도 소진까지 지속되면 HttpStatusError(status=503)를 throw한다', async () => {
    let callCount = 0;
    const { url, close } = await startServer((req, res) => {
      callCount++;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unavailable' }));
    });

    try {
      await expect(
        fetchWithRetry(
          url,
          { method: 'GET' },
          { timeoutMs: 2000, maxRetries: 2, isRetryableStatus: (s) => s >= 500, computeBackoffMs: NO_DELAY },
        ),
      ).rejects.toMatchObject({ status: 503 });
      // 최초 1회 + 재시도 2회 = 총 3회 시도
      expect(callCount).toBe(3);
    } finally {
      await close();
    }
  });

  test('400(영구적 오류)은 재시도 없이 즉시 HttpStatusError를 throw한다', async () => {
    let callCount = 0;
    const { url, close } = await startServer((req, res) => {
      callCount++;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad request' }));
    });

    try {
      await expect(
        fetchWithRetry(
          url,
          { method: 'GET' },
          { timeoutMs: 2000, maxRetries: 2, isRetryableStatus: (s) => s >= 500 || s === 429, computeBackoffMs: NO_DELAY },
        ),
      ).rejects.toBeInstanceOf(HttpStatusError);
      expect(callCount).toBe(1);
    } finally {
      await close();
    }
  });

  test('응답이 타임아웃 시간 내 오지 않으면 HttpTimeoutError를 throw하고 확실히 중단된다', async () => {
    const { url, close } = await startServer((_req, _res) => {
      // 의도적으로 응답하지 않는다(연결을 열어둔 채 방치) → 타임아웃 유도
    });

    try {
      const start = Date.now();
      await expect(
        fetchWithRetry(
          url,
          { method: 'GET' },
          { timeoutMs: 200, maxRetries: 0, isRetryableStatus: () => false, computeBackoffMs: NO_DELAY },
        ),
      ).rejects.toBeInstanceOf(HttpTimeoutError);
      const elapsed = Date.now() - start;
      // 타임아웃(200ms) 근처에서 확실히 중단되어야 한다(행 걸림 없음)
      expect(elapsed).toBeLessThan(2000);
    } finally {
      await close();
    }
  });

  test('연결 거부(네트워크 오류)는 재시도 후에도 실패하면 Error를 throw한다', async () => {
    // 아무 서버도 열지 않은 포트로 연결을 시도해 ECONNREFUSED를 유도한다.
    await expect(
      fetchWithRetry(
        'http://127.0.0.1:1',
        { method: 'GET' },
        { timeoutMs: 500, maxRetries: 1, isRetryableStatus: () => false, computeBackoffMs: NO_DELAY },
      ),
    ).rejects.toBeInstanceOf(Error);
  });

  test('H-2: Retry-After가 상한(20초)을 초과하면 그 값만큼 기다리지 않고 즉시 재시도를 포기한다', async () => {
    let callCount = 0;
    const { url, close } = await startServer((req, res) => {
      callCount++;
      // 서버가 1시간(3600초) 대기를 요청해도, 상한을 초과하는 힌트는 즉시 실패로 처리해야
      // 단일 채점 요청이 무제한 지연되는 것을 막는다(NFR-4.1/FR-7.7).
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '3600' });
      res.end(JSON.stringify({ error: 'rate limited' }));
    });

    try {
      const start = Date.now();
      // computeBackoffMs를 오버라이드하지 않고 실제 defaultBackoffMs의 캡 로직을 검증한다.
      await expect(
        fetchWithRetry(
          url,
          { method: 'GET' },
          { timeoutMs: 2000, maxRetries: 3, isRetryableStatus: (s) => s === 429 },
        ),
      ).rejects.toMatchObject({ status: 429 });
      // 3600초를 기다리지 않고 수 초 내에 실패해야 한다.
      expect(Date.now() - start).toBeLessThan(3000);
      // 상한 초과 판정 즉시 포기하므로 최초 1회 호출 후 재시도하지 않는다.
      expect(callCount).toBe(1);
    } finally {
      await close();
    }
  });

  test('H-2: Retry-After가 상한 이내면 그 값만큼 대기한 뒤 정상적으로 재시도한다', async () => {
    let callCount = 0;
    const timestamps: number[] = [];
    const { url, close } = await startServer((req, res) => {
      callCount++;
      timestamps.push(Date.now());
      if (callCount === 1) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
        res.end(JSON.stringify({ error: 'rate limited' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    try {
      const { response, attempts } = await fetchWithRetry(
        url,
        { method: 'GET' },
        { timeoutMs: 3000, maxRetries: 2, isRetryableStatus: (s) => s === 429 },
      );
      expect(response.ok).toBe(true);
      expect(attempts).toBe(2);
      expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(900);
    } finally {
      await close();
    }
  }, 10000);

  describe('L-8(리뷰 round2, Low): null-body 상태코드(204/205/304)', () => {
    /**
     * 리뷰 round2 L-8 수정 후: 204/205처럼 body를 가질 수 없는("null body") 상태코드는
     * `new Response(bodyText, { status, ... })` 재구성 자체가 body 유무와 무관하게 거부되므로
     * (`TypeError: Response constructor: Invalid response status code 204`), 버퍼링 재구성을
     * 건너뛰고 원본 응답을 그대로 반환하도록 수정했다. 더 이상 이 TypeError가 "네트워크 오류"로
     * 오분류되어 불필요한 재시도를 유발하지 않는다 — 최초 1회 호출로 정상 성공해야 한다.
     */
    test('204(No Content)는 재시도 없이 원본 응답을 그대로 반환한다', async () => {
      let callCount = 0;
      const { url, close } = await startServer((req, res) => {
        callCount++;
        res.writeHead(204, {});
        res.end();
      });

      try {
        const { response, attempts } = await fetchWithRetry(
          url,
          { method: 'GET' },
          { timeoutMs: 2000, maxRetries: 1, isRetryableStatus: () => false, computeBackoffMs: NO_DELAY },
        );
        expect(response.ok).toBe(true);
        expect(response.status).toBe(204);
        expect(attempts).toBe(1);
        expect(callCount).toBe(1);
      } finally {
        await close();
      }
    });

    test('205(Reset Content)도 204와 동일하게 재시도 없이 원본 응답을 그대로 반환한다', async () => {
      let callCount = 0;
      const { url, close } = await startServer((req, res) => {
        callCount++;
        res.writeHead(205, {});
        res.end();
      });

      try {
        const { response, attempts } = await fetchWithRetry(
          url,
          { method: 'GET' },
          { timeoutMs: 2000, maxRetries: 0, isRetryableStatus: () => false, computeBackoffMs: NO_DELAY },
        );
        expect(response.ok).toBe(true);
        expect(response.status).toBe(205);
        expect(attempts).toBe(1);
        expect(callCount).toBe(1);
      } finally {
        await close();
      }
    });

    test('304(Not Modified)는 response.ok가 false라 버퍼링 경로를 타지 않고 즉시 HttpStatusError로 실패한다(오도된 재시도 없음)', async () => {
      // 304는 2xx 범위가 아니므로 `response.ok`가 false다 → "성공(ok)" 분기의 버퍼링 코드를
      // 거치지 않고, isRetryableStatus(기본적으로 재시도 대상 아님) 판단에 따라 즉시
      // HttpStatusError를 던진다. 즉 L-8의 null-body Response 생성자 문제는 204/205(2xx)에서만
      // 재현되고, 304는 애초에 그 코드 경로에 도달하지 않는다 — 이 경계를 명시적으로 고정한다.
      let callCount = 0;
      const { url, close } = await startServer((req, res) => {
        callCount++;
        res.writeHead(304, {});
        res.end();
      });

      try {
        await expect(
          fetchWithRetry(
            url,
            { method: 'GET' },
            { timeoutMs: 2000, maxRetries: 1, isRetryableStatus: () => false, computeBackoffMs: NO_DELAY },
          ),
        ).rejects.toMatchObject({ name: 'HttpStatusError', status: 304 });
        expect(callCount).toBe(1);
      } finally {
        await close();
      }
    });
  });

  test('M-1: 헤더 응답 후 본문 전송이 멈추면 GEMINI_TIMEOUT_MS 상당의 타임아웃 내에 중단된다', async () => {
    const { url, close } = await startServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"ok": '); // 헤더는 보냈지만 본문을 끝맺지 않고 연결을 열어둔다.
      // 의도적으로 res.end()를 호출하지 않는다 → 본문 수신 구간에서 멈춘 상황을 재현.
    });

    try {
      const start = Date.now();
      await expect(
        fetchWithRetry(
          url,
          { method: 'GET' },
          { timeoutMs: 200, maxRetries: 0, isRetryableStatus: () => false, computeBackoffMs: NO_DELAY },
        ),
      ).rejects.toBeInstanceOf(HttpTimeoutError);
      const elapsed = Date.now() - start;
      // 본문 수신 구간도 타임아웃 보호 대상이어야 한다(헤더만 보호되던 이전 버그라면 undici
      // 기본 bodyTimeout까지 대기해 훨씬 오래 걸린다).
      expect(elapsed).toBeLessThan(2000);
    } finally {
      await close();
    }
  });
});
