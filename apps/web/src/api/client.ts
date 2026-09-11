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
