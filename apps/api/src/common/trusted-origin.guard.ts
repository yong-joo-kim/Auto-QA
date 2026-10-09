import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';

const DEFAULT_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

/**
 * 허용 출처 목록. env `CORS_ORIGINS`(쉼표 구분)로 지정하고, 미지정 시 로컬 Vite 개발 서버만 허용한다.
 * `*`을 넣으면 모든 출처를 허용한다(비권장: 개발 편의용).
 */
export function getAllowedOrigins(): string[] {
  const raw = process.env.CORS_ORIGINS;
  if (!raw || raw.trim() === '') return DEFAULT_ORIGINS;
  return raw
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/**
 * 상태를 바꾸는 엔드포인트(평가시트 업로드/복원)용 최소 CSRF 완화책(M-5).
 * multipart POST는 CORS 단순 요청이라 프리플라이트 없이 전송되므로, 브라우저가 항상 붙이는 Origin 헤더를
 * 서버에서 검증한다. Origin이 없는 요청(curl/서버 간 호출)은 브라우저 CSRF 경로가 아니므로 통과시킨다.
 * 인증/권한 도입 전까지의 임시 조치이며, 인증을 대체하지 않는다.
 */
@Injectable()
export class TrustedOriginGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const origin = req.headers.origin;
    if (!origin) return true;

    const allowed = getAllowedOrigins();
    if (allowed.includes('*') || allowed.includes(origin.replace(/\/+$/, ''))) return true;
    // 같은 출처(웹이 API와 같은 호스트로 프록시되는 구성)
    try {
      if (new URL(origin).host === req.headers.host) return true;
    } catch {
      // 파싱 불가한 Origin(예: "null")은 거부
    }
    throw new ForbiddenException('허용되지 않은 출처의 요청입니다.');
  }
}
