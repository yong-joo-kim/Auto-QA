import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { listSupportedDomainIds, loadSeedEvalSheet } from '@auto-qa/eval-schema';
import { buildEvalSheetWorkbook } from './eval-sheet-xlsx';
import { EvalSheetsController } from './eval-sheets.controller';
import { EvalSheetsService } from './eval-sheets.service';

/** 컨트롤러 계층 회귀 테스트: 업로드 검증(L-6), Origin 검증(M-5), 복원 엔드포인트. */
describe('EvalSheetsController', () => {
  let app: INestApplication;
  let baseUrl: string;
  let dir: string;
  const prevDir = process.env.EVAL_SHEETS_OVERRIDE_DIR;
  const prevCors = process.env.CORS_ORIGINS;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [EvalSheetsController],
      providers: [EvalSheetsService],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.listen(0);
    baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalsheets-ctrl-'));
    process.env.EVAL_SHEETS_OVERRIDE_DIR = dir;
    delete process.env.CORS_ORIGINS;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (prevDir === undefined) delete process.env.EVAL_SHEETS_OVERRIDE_DIR;
    else process.env.EVAL_SHEETS_OVERRIDE_DIR = prevDir;
    if (prevCors === undefined) delete process.env.CORS_ORIGINS;
    else process.env.CORS_ORIGINS = prevCors;
  });

  const validXlsx = () => buildEvalSheetWorkbook(listSupportedDomainIds().map((id) => loadSeedEvalSheet(id)));

  async function upload(
    content: Buffer | undefined,
    opts: { fileName?: string; field?: string; origin?: string } = {},
  ): Promise<Response> {
    const form = new FormData();
    if (content) {
      form.append(opts.field ?? 'file', new Blob([new Uint8Array(content)]), opts.fileName ?? 'sheets.xlsx');
    }
    return fetch(`${baseUrl}/eval-sheets/upload`, {
      method: 'POST',
      body: form,
      headers: opts.origin ? { Origin: opts.origin } : {},
    });
  }

  test('GET /eval-sheets 는 10개 도메인 요약을 반환한다', async () => {
    const res = await fetch(`${baseUrl}/eval-sheets`);
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(10);
  });

  test('GET /eval-sheets/download 는 xlsx 첨부 헤더와 zip 본문을 반환한다', async () => {
    const res = await fetch(`${baseUrl}/eval-sheets/download`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('attachment');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.readUInt32LE(0)).toBe(0x04034b50);
  });

  test('파일 없이 업로드하면 400', async () => {
    const res = await upload(undefined);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('파일을 선택');
  });

  test('확장자가 .xlsx 가 아니면 400', async () => {
    const res = await upload(await validXlsx(), { fileName: 'sheets.csv' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('.xlsx');
  });

  test('확장자만 .xlsx 이고 zip 시그니처가 없으면 400', async () => {
    const res = await upload(Buffer.from('this is not a zip file'), { fileName: 'fake.xlsx' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('올바른 .xlsx');
  });

  test('필드명이 file 이 아니면 400', async () => {
    const res = await upload(await validXlsx(), { field: 'attachment' });
    expect(res.status).toBe(400);
  });

  test('5MB 를 초과하면 413', async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 1024, 1);
    big.writeUInt32LE(0x04034b50, 0);
    const res = await upload(big);
    expect(res.status).toBe(413);
  });

  test('정상 업로드는 200과 updated/ignoredSheets 를 반환한다(변경 없음)', async () => {
    const res = await upload(await validXlsx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: [], ignoredSheets: ['00_안내'] });
  });

  test('허용되지 않은 Origin 의 업로드/복원은 403 이고 반영되지 않는다', async () => {
    const up = await upload(await validXlsx(), { origin: 'https://evil.example.com' });
    expect(up.status).toBe(403);

    const del = await fetch(`${baseUrl}/eval-sheets/telecom/override`, {
      method: 'DELETE',
      headers: { Origin: 'https://evil.example.com' },
    });
    expect(del.status).toBe(403);
  });

  test('허용된 Origin(기본 localhost:5173 / CORS_ORIGINS)과 Origin 없는 요청은 통과한다', async () => {
    expect((await upload(await validXlsx(), { origin: 'http://localhost:5173' })).status).toBe(200);
    expect((await upload(await validXlsx())).status).toBe(200);

    process.env.CORS_ORIGINS = 'https://qa.example.com';
    expect((await upload(await validXlsx(), { origin: 'https://qa.example.com' })).status).toBe(200);
    expect((await upload(await validXlsx(), { origin: 'http://localhost:5173' })).status).toBe(403);
  });

  test('DELETE override: 수정본이 없으면 400, 미지원 도메인은 404, 수정본이 있으면 204', async () => {
    const none = await fetch(`${baseUrl}/eval-sheets/telecom/override`, { method: 'DELETE' });
    expect(none.status).toBe(400);

    const unknown = await fetch(`${baseUrl}/eval-sheets/no-such/override`, { method: 'DELETE' });
    expect(unknown.status).toBe(404);

    fs.writeFileSync(path.join(dir, 'telecom.json'), JSON.stringify(loadSeedEvalSheet('telecom')), 'utf-8');
    const ok = await fetch(`${baseUrl}/eval-sheets/telecom/override`, { method: 'DELETE' });
    expect(ok.status).toBe(204);
  });

  describe('GET /eval-sheets/:domainId (평가시트 보기)', () => {
    test('도메인의 구분/항목/세부내용/배점/게이팅 정의를 반환한다', async () => {
      const res = await fetch(`${baseUrl}/eval-sheets/telecom`);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual(loadSeedEvalSheet('telecom'));
    });

    test('download 경로는 :domainId에 가려지지 않는다', async () => {
      const res = await fetch(`${baseUrl}/eval-sheets/download`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('spreadsheetml');
    });

    test('미지원 도메인은 404', async () => {
      expect((await fetch(`${baseUrl}/eval-sheets/not-a-domain`)).status).toBe(404);
    });

    test('손상된 수정본은 500과 원인 메시지', async () => {
      fs.writeFileSync(path.join(dir, 'telecom.json'), '{broken');
      const res = await fetch(`${baseUrl}/eval-sheets/telecom`);
      expect(res.status).toBe(500);
    });
  });
});
