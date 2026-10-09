import type {
  ApiErrorResponse,
  CreateTranscriptRequest,
  CreateTranscriptResponse,
  EvaluationResultResponse,
  OverrideItemScoreRequest,
} from '@auto-qa/shared-types';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000').replace(
  /\/$/,
  '',
);

/** API 호출 실패 시 사용자에게 노출 가능한 메시지를 담는 에러 클래스. */
export class ApiError extends Error {
  status?: number;
  kind: 'validation' | 'not-found' | 'server' | 'network';

  constructor(message: string, kind: ApiError['kind'], status?: number) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
  }
}

async function parseErrorBody(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as ApiErrorResponse;
    if (Array.isArray(body.message)) {
      return body.message.join(', ');
    }
    return body.message;
  } catch {
    return undefined;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError('서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.', 'network');
  }

  if (!response.ok) {
    const serverMessage = await parseErrorBody(response);
    if (response.status === 404) {
      throw new ApiError(serverMessage ?? '요청하신 데이터를 찾을 수 없습니다.', 'not-found', 404);
    }
    if (response.status === 400) {
      throw new ApiError(serverMessage ?? '입력값을 확인해 주세요.', 'validation', 400);
    }
    throw new ApiError(
      serverMessage ?? '채점 요청 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
      'server',
      response.status,
    );
  }

  return (await response.json()) as T;
}

export function createTranscript(
  payload: CreateTranscriptRequest,
): Promise<CreateTranscriptResponse> {
  return request<CreateTranscriptResponse>('/transcripts', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function getEvaluationResult(transcriptId: string): Promise<EvaluationResultResponse> {
  return request<EvaluationResultResponse>(`/transcripts/${encodeURIComponent(transcriptId)}`);
}

/** PATCH /evaluations/:id/items/:itemId — 점수 수동 보정(Override, FR-10, §4.5) */
export function overrideItemScore(
  evaluationId: string,
  itemId: string,
  payload: OverrideItemScoreRequest,
): Promise<EvaluationResultResponse> {
  return request<EvaluationResultResponse>(
    `/evaluations/${encodeURIComponent(evaluationId)}/items/${encodeURIComponent(itemId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(payload),
    },
  );
}

/** GET /eval-sheets 응답 한 행 */
export interface EvalSheetSummary {
  domainId: string;
  domainName: string;
  version: string;
  totalMaxScore: number;
  categoryCount: number;
  itemCount: number;
  gatingItemCount: number;
  customized: boolean;
  updatedAt?: string;
}

export interface UploadEvalSheetsResult {
  updated: { domainId: string; domainName: string; version: string; itemCount: number }[];
  ignoredSheets: string[];
}

/** GET /eval-sheets/:domainId — 평가시트 정의(보기 화면용) */
export interface EvalSheetDetail {
  domainId: string;
  domainName: string;
  version: string;
  mainConsultationTypes?: string;
  totalMaxScore: number;
  gradeCriteria: { minScore: number; grade: string }[];
  gatingPolicy?: string;
  categories: {
    categoryId: string;
    categoryName: string;
    maxScore: number;
    items: { itemId: string; itemName: string; criteria: string; maxScore: number; gating: boolean }[];
  }[];
  sourceCitation?: string;
  disclaimer?: string;
}

export function getEvalSheetDetail(domainId: string): Promise<EvalSheetDetail> {
  return request<EvalSheetDetail>(`/eval-sheets/${encodeURIComponent(domainId)}`);
}

export function listEvalSheets(): Promise<EvalSheetSummary[]> {
  return request<EvalSheetSummary[]>('/eval-sheets');
}

/** 업로드 검증 오류: 서버가 내려준 항목별 메시지 배열을 `details`로 보관한다. */
export class UploadValidationError extends Error {
  details: string[];
  constructor(details: string[]) {
    super(details[0] ?? '업로드한 평가시트 검증에 실패했습니다.');
    this.name = 'UploadValidationError';
    this.details = details;
  }
}

export async function uploadEvalSheets(file: File): Promise<UploadEvalSheetsResult> {
  const form = new FormData();
  form.append('file', file);
  let response: Response;
  try {
    // Content-Type은 브라우저가 multipart boundary와 함께 설정해야 하므로 지정하지 않는다.
    response = await fetch(`${API_BASE_URL}/eval-sheets/upload`, { method: 'POST', body: form });
  } catch {
    throw new ApiError('서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.', 'network');
  }
  if (!response.ok) {
    let messages: string[] = [];
    try {
      const body = (await response.json()) as ApiErrorResponse;
      messages = Array.isArray(body.message) ? body.message : body.message ? [body.message] : [];
    } catch {
      /* 본문 없음 */
    }
    if (response.status === 400 && messages.length > 0) throw new UploadValidationError(messages);
    throw new ApiError(
      response.status === 413 ? '파일이 너무 큽니다(최대 5MB).' : '업로드 중 오류가 발생했습니다.',
      'server',
      response.status,
    );
  }
  return (await response.json()) as UploadEvalSheetsResult;
}

export async function resetEvalSheet(domainId: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/eval-sheets/${encodeURIComponent(domainId)}/override`, {
      method: 'DELETE',
    });
  } catch {
    throw new ApiError('서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.', 'network');
  }
  if (!response.ok) {
    // 서버 메시지(이미 기본 시트 사용 중 400, 미지원 도메인 404 등)를 우선 사용한다.
    const serverMessage = await parseErrorBody(response);
    throw new ApiError(serverMessage ?? '기본 평가시트로 되돌리지 못했습니다.', 'server', response.status);
  }
}

/** 평가시트 다운로드 URL. */
export const EVAL_SHEETS_DOWNLOAD_URL = `${API_BASE_URL}/eval-sheets/download`;

function filenameFromDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      /* 아래 일반 filename으로 대체 */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain?.[1].trim();
}

/** 평가시트를 fetch로 받아 Blob 저장한다. 실패하면 ApiError를 던져 화면에서 안내할 수 있게 한다. */
export async function downloadEvalSheets(): Promise<void> {
  let response: Response;
  try {
    response = await fetch(EVAL_SHEETS_DOWNLOAD_URL);
  } catch {
    throw new ApiError('서버에 연결할 수 없습니다. 네트워크 상태를 확인해 주세요.', 'network');
  }
  if (!response.ok) {
    const serverMessage = await parseErrorBody(response);
    throw new ApiError(
      serverMessage ?? '평가시트를 다운로드하지 못했습니다. 잠시 후 다시 시도해 주세요.',
      'server',
      response.status,
    );
  }
  const blob = await response.blob();
  const filename = filenameFromDisposition(response.headers.get('Content-Disposition')) ?? 'eval-sheets.xlsx';
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
