import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiError, UploadValidationError, downloadEvalSheet, downloadEvalSheets, resetEvalSheet, uploadEvalSheets } from './client';

/** client.ts 의 평가시트 관련 순수 로직(fetch 모킹). 컴포넌트 렌더링은 범위 밖. */

function jsonResponse(status: number, body?: unknown) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status });
}

describe('eval-sheets client', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('downloadEvalSheets', () => {
    function stubDom() {
      const a = { href: '', download: '', click: vi.fn(), remove: vi.fn() };
      vi.stubGlobal('document', { createElement: vi.fn(() => a), body: { appendChild: vi.fn() } });
      vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
      return a;
    }

    test('filename*=UTF-8 헤더를 디코딩해 파일명으로 쓴다', async () => {
      const a = stubDom();
      const name = '평가시트_2026.xlsx';
      fetchMock.mockResolvedValue(
        new Response('x', {
          status: 200,
          headers: { 'Content-Disposition': `attachment; filename="a.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}` },
        }),
      );
      await downloadEvalSheets();
      expect(a.download).toBe(name);
      expect(a.click).toHaveBeenCalledTimes(1);
    });

    test('일반 filename 만 있으면 그 값을, 헤더가 없으면 기본 파일명을 쓴다', async () => {
      const a = stubDom();
      fetchMock.mockResolvedValueOnce(
        new Response('x', { status: 200, headers: { 'Content-Disposition': 'attachment; filename="sheets.xlsx"' } }),
      );
      await downloadEvalSheets();
      expect(a.download).toBe('sheets.xlsx');
      fetchMock.mockResolvedValueOnce(new Response('x', { status: 200 }));
      await downloadEvalSheets();
      expect(a.download).toBe('eval-sheets.xlsx');
    });

    test('downloadEvalSheet 은 도메인별 경로를 호출하고 헤더가 없으면 도메인ID 파일명을 쓴다', async () => {
      const a = stubDom();
      fetchMock.mockResolvedValue(new Response('x', { status: 200 }));
      await downloadEvalSheet('telecom');
      expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/eval-sheets\/telecom\/download$/);
      expect(a.download).toBe('telecom.xlsx');
    });

    test('잘못된 퍼센트 인코딩이면 일반 filename 으로 대체한다', async () => {
      const a = stubDom();
      fetchMock.mockResolvedValue(
        new Response('x', {
          status: 200,
          headers: { 'Content-Disposition': "attachment; filename=\"ok.xlsx\"; filename*=UTF-8''%E0%A4%A" },
        }),
      );
      await downloadEvalSheets();
      expect(a.download).toBe('ok.xlsx');
    });

    test('서버 오류는 서버 메시지를 담은 ApiError, 없으면 기본 메시지', async () => {
      stubDom();
      fetchMock.mockResolvedValueOnce(jsonResponse(500, { message: '평가시트 파일이 손상되었습니다.' }));
      await expect(downloadEvalSheets()).rejects.toMatchObject({
        message: '평가시트 파일이 손상되었습니다.',
        kind: 'server',
        status: 500,
      });
      fetchMock.mockResolvedValueOnce(jsonResponse(500));
      await expect(downloadEvalSheets()).rejects.toMatchObject({
        message: expect.stringContaining('다운로드하지 못했습니다'),
        status: 500,
      });
    });

    test('네트워크 오류는 network 종류의 ApiError', async () => {
      fetchMock.mockRejectedValue(new TypeError('fail'));
      await expect(downloadEvalSheets()).rejects.toMatchObject({ kind: 'network' });
    });
  });

  describe('resetEvalSheet', () => {
    test('성공 시 DELETE 로 도메인 id 를 인코딩해 호출한다', async () => {
      fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
      await expect(resetEvalSheet('tele com')).resolves.toBeUndefined();
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toMatch(/\/eval-sheets\/tele%20com\/override$/);
      expect(init).toMatchObject({ method: 'DELETE' });
    });

    test('서버 메시지(배열 포함)를 우선 사용하고 상태코드를 보존한다', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(400, { message: '이미 기본 평가시트를 사용 중입니다.' }));
      await expect(resetEvalSheet('telecom')).rejects.toMatchObject({
        message: '이미 기본 평가시트를 사용 중입니다.',
        status: 400,
      });
      fetchMock.mockResolvedValueOnce(jsonResponse(404, { message: ['a', 'b'] }));
      await expect(resetEvalSheet('x')).rejects.toMatchObject({ message: 'a, b', status: 404 });
    });

    test('본문이 없으면 기본 메시지, 네트워크 오류는 network', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(500));
      await expect(resetEvalSheet('telecom')).rejects.toMatchObject({
        message: '기본 평가시트로 되돌리지 못했습니다.',
        status: 500,
      });
      fetchMock.mockRejectedValueOnce(new TypeError('fail'));
      await expect(resetEvalSheet('telecom')).rejects.toMatchObject({ kind: 'network' });
    });
  });

  describe('uploadEvalSheets', () => {
    const file = new File([new Uint8Array([1])], 'a.xlsx');

    test('성공 시 응답을 그대로 반환하고 Content-Type 을 직접 지정하지 않는다', async () => {
      const body = {
        updated: [{ domainId: 'telecom', domainName: '통신', version: '1.0.1', itemCount: 10 }],
        ignoredSheets: ['00_안내'],
      };
      fetchMock.mockResolvedValue(jsonResponse(200, body));
      await expect(uploadEvalSheets(file)).resolves.toEqual(body);
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toMatch(/\/eval-sheets\/upload$/);
      expect(init.method).toBe('POST');
      expect(init.headers).toBeUndefined();
      expect(init.body).toBeInstanceOf(FormData);
    });

    test('400 + 메시지 배열은 UploadValidationError(details 보존)', async () => {
      fetchMock.mockResolvedValue(jsonResponse(400, { message: ['3_통신: 합계 오류', '5_금융: 중복'] }));
      const err = await uploadEvalSheets(file).catch((e) => e);
      expect(err).toBeInstanceOf(UploadValidationError);
      expect(err.details).toEqual(['3_통신: 합계 오류', '5_금융: 중복']);
      expect(err.message).toBe('3_통신: 합계 오류');
    });

    test('400 + 단일 문자열 메시지도 details 배열로 감싼다', async () => {
      fetchMock.mockResolvedValue(jsonResponse(400, { message: '파일이 없습니다.' }));
      const err = await uploadEvalSheets(file).catch((e) => e);
      expect(err).toBeInstanceOf(UploadValidationError);
      expect(err.details).toEqual(['파일이 없습니다.']);
    });

    test('413 은 용량 안내, 본문 없는 400 및 500 은 일반 ApiError', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(413, { message: 'Payload too large' }));
      await expect(uploadEvalSheets(file)).rejects.toMatchObject({
        message: '파일이 너무 큽니다(최대 5MB).',
        status: 413,
        kind: 'server',
      });
      fetchMock.mockResolvedValueOnce(jsonResponse(400));
      const e400 = await uploadEvalSheets(file).catch((e) => e);
      expect(e400).toBeInstanceOf(ApiError);
      expect(e400).not.toBeInstanceOf(UploadValidationError);
      expect(e400.status).toBe(400);
      fetchMock.mockResolvedValueOnce(jsonResponse(500, { message: 'boom' }));
      await expect(uploadEvalSheets(file)).rejects.toMatchObject({
        message: '업로드 중 오류가 발생했습니다.',
        status: 500,
      });
    });

    test('네트워크 오류는 network 종류의 ApiError', async () => {
      fetchMock.mockRejectedValue(new TypeError('fail'));
      await expect(uploadEvalSheets(file)).rejects.toMatchObject({ kind: 'network' });
    });
  });
});
