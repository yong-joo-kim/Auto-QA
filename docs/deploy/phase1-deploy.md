# Phase 1 (Vertical Slice — 통신 도메인) 로컬 실행/배포 확인

- 대상 커밋: `fcf6cb1` (재리뷰 통과, `docs/review/phase1-vertical-slice-review-round2.md`, 테스트 46/46 통과 `docs/test/phase1-vertical-slice-report.md`)
- 검증 환경: Windows 11, Node v24.19.0, pnpm 12.3.4(workspace `packageManager` 고정)
- 범위: 로컬 `pnpm dev` 기동까지. **Docker/CI 인프라(`infra/**`)는 이번 Phase 범위에 없음** — 저장소에 아직 `infra/` 디렉터리가 없고, PM 지시(Phase별 전개표 §CLAUDE.md)상 컨테이너화/CI는 Phase 6(CI/배포)에서 다룬다. 필요 시 Phase 6에서 `docker-compose.yml`(api/web/postgres 분리, dev는 SQLite 유지) + `Dockerfile.api`/`Dockerfile.web`을 신규 작성한다.

## 1. 실행 방법

### 1.1 준비

```bash
pnpm install
cp .env.example .env   # 이미 존재하면 생략. ANTHROPIC_API_KEY 등은 빈 값 유지(LLM_PROVIDER=mock)
```

`.env` 핵심 값(Phase 1 기본값):

| 변수 | 기본값 | 설명 |
|---|---|---|
| `LLM_PROVIDER` | `mock` | 실제 API 키 없이 결정론적 더미 채점 사용 |
| `DATABASE_URL` | `file:./dev.db` | `apps/api/prisma/dev.db` (SQLite), gitignore 처리됨 |
| `API_PORT` | `3000` | NestJS API 포트 |
| `MOCK_LLM_FAILURE_RATE` | `0` | 테스트 전용 오류 주입 확률 |
| (web) `VITE_API_BASE_URL` | 미설정 시 `http://localhost:3000` | `apps/web/src/api/client.ts` 기본값 |

### 1.2 Prisma 클라이언트 생성 (최초 1회 또는 스키마 변경 시)

```bash
pnpm --filter @auto-qa/api exec prisma generate
```

> **주의(L-13, Windows EPERM)**: 아래 "2.2" 참조 — API dev 서버(또는 다른 노드 프로세스)가 이미 떠 있는 상태에서 `prisma generate`/`pnpm -r build`를 실행하면 실패한다. dev 서버를 먼저 종료한 뒤 실행할 것.

### 1.3 기동 (수정됨 — L-9 해결)

루트에서 한 번에 API + Web 기동:

```bash
pnpm dev
```

- API: NestJS, `http://localhost:3000` (ts-node-dev, hot reload)
- Web: Vite dev server, `http://localhost:5173` (`/transcripts/new`로 자동 리다이렉트)

개별 기동이 필요하면:

```bash
pnpm --filter @auto-qa/api dev     # == start:dev, ts-node-dev
pnpm --filter @auto-qa/web dev     # == vite
```

### 1.4 확인 방법 (헬스체크)

Phase 1에는 전용 `/health` 엔드포인트가 없다. 대신 아래로 기동 여부를 확인한다.

```bash
# API가 응답하는지 (트랜스크립트 생성 자체가 헬스체크 역할)
curl -X POST http://localhost:3000/transcripts \
  -H "Content-Type: application/json" \
  -d '{"domainId":"telecom","rawText":"상담사: 안녕하세요.\n고객: 문의드립니다.\n상담사: 네 안내해드리겠습니다.\n고객: 감사합니다."}'
# => 201 { "transcriptId": "...", "evaluationId": "..." }

curl http://localhost:3000/transcripts/<transcriptId>
# => 200, 채점 결과 JSON(items/categoryScores/totalScore/grade 등)

# Web dev 서버 응답 확인
curl -I http://localhost:5173/transcripts/new   # => 200
```

후속 Phase 권고: `GET /health`(DB 연결 + eval-sheet 로딩 상태 리턴) 추가하면 Docker/CI 헬스체크와 연동하기 쉬움 — Phase 6에서 함께 처리 권고.

## 2. 확인한 시나리오

### 2.1 실제 왕복 확인 (요청 1)

1. `pnpm dev`로 API(3000)/Web(5173) 동시 기동 확인.
2. `curl -I http://localhost:5173/transcripts/new` → 200 (SPA 라우트 정상 서빙).
3. `POST /transcripts` (domainId=`telecom`, PII 포함 원문: 전화번호 `010-1234-5678`) → `201 Created`, `transcriptId`/`evaluationId` 반환.
4. `GET /transcripts/:id` → `200`, Mock LLM 채점 결과(항목별 score/reason, categoryScores, totalScore, grade, gatingResult, goodPoints/improvements, profanityCheck) 정상 반환 확인.
5. `GET /transcripts/:id`(Web 라우트) → 200 (React가 클라이언트에서 위 API를 호출해 렌더링하는 구조이며, API 응답 자체는 3~4에서 별도 검증 완료).

브라우저 GUI 조작(마우스 클릭 등)은 이 세션에서 별도 브라우저 자동화 도구가 없어 수행하지 않았고, 대신 (a) SPA 라우트가 200으로 서빙되는지, (b) 프런트가 호출하는 것과 동일한 API 계약을 curl로 직접 왕복시켜 데이터가 정상 형성되는지를 확인했다. `apps/web/src/api/client.ts`의 기본 `API_BASE_URL`(`http://localhost:3000`)이 실제 API 포트와 일치함을 코드로 확인했다.

### 2.2 Windows `prisma generate` EPERM 재현 (L-13, 요청 2)

**재현 성공.** 원인: API dev 서버(ts-node-dev)가 이미 로드한 `query_engine-windows.dll.node`를 Windows가 프로세스 종료 전까지 잠그기 때문에, 같은 파일을 재생성(rename)하려는 `prisma generate`가 `EPERM: operation not permitted, rename '...query_engine-windows.dll.node.tmpXXXX' -> '...query_engine-windows.dll.node'`로 실패한다.

재현 절차:
1. `pnpm --filter @auto-qa/api dev` 로 API dev 서버 기동(백그라운드).
2. 같은 상태에서 `pnpm --filter @auto-qa/api exec prisma generate` 실행 → EPERM 발생(실측 확인).
3. dev 서버를 기동하지 않은 상태에서 동일 명령 실행 → 정상 성공. `pnpm -r build`(루트, prisma generate 포함)도 dev 서버 미기동 시 정상 완료 확인.

**회피 방법(채택)**:
- API dev 서버/이전 `node`(ts-node-dev) 프로세스를 먼저 종료한 뒤 `prisma generate` 또는 `pnpm -r build`를 실행한다. (Prisma 스키마를 바꾸지 않는 일반적인 개발 흐름에서는 최초 1회만 generate하면 되므로 실무 영향은 제한적)
- 스키마 변경 없이 **타입체크만** 필요한 경우 `prisma generate`를 재실행할 필요가 없다는 점을 활용해, `apps/api/package.json`에 `typecheck` 스크립트를 신설했다(`tsc -p tsconfig.json --noEmit`, prisma generate 미포함). dev 서버를 켠 채로도 안전하게 실행 가능함을 실측 확인.
  ```bash
  pnpm --filter @auto-qa/api typecheck   # dev 서버 실행 중에도 안전
  ```
- 코드 결함이 아니라 Windows의 파일 잠금 특성이므로 근본 해결책은 없음. CI(Linux 러너)에서는 재현되지 않을 것으로 예상되며(파일 잠금 모델이 다름), Phase 6에서 CI 워크플로 작성 시 별도 확인 권고.

### 2.3 `pnpm dev` API 미기동 수정 (L-9, 요청 3)

**원인**: `apps/api/package.json`에 `dev` 스크립트가 없었다(`start:dev`만 존재). 루트 `pnpm --parallel -r --filter=./apps/* dev`는 `dev` 스크립트가 없는 워크스페이스를 에러 없이 조용히 건너뛰므로, `pnpm dev` 실행 시 Web만 뜨고 API는 기동되지 않았다(재현 확인).

**조치(적용됨)**: `apps/api/package.json`에 `dev` 스크립트를 `start:dev`와 동일하게 추가.

```diff
  "start:dev": "ts-node-dev --respawn --transpile-only -r tsconfig-paths/register src/main.ts",
+ "dev": "ts-node-dev --respawn --transpile-only -r tsconfig-paths/register src/main.ts",
+ "typecheck": "tsc -p tsconfig.json --noEmit",
```

루트 `pnpm dev` 실행 후 API(3000)/Web(5173) 동시 기동 및 두 포트 모두 정상 응답을 실측 확인했다(2.1 참조). 별도의 `concurrently` 도입 없이 기존 `pnpm --parallel -r --filter=./apps/* dev` 구조를 그대로 활용했다(추가 의존성 불필요).

### 2.4 ESLint 최소 구성 (M-7, 요청 4)

**조치(적용됨)**: 루트에 flat config(`eslint.config.js`) 신설, `eslint`/`typescript-eslint`/`eslint-plugin-react-hooks`를 루트 devDependencies로 추가(`pnpm add -D -w`). 범위:

- `typescript-eslint` 권장 규칙(비-타입체크, 즉 `tseslint.configs.recommended`)을 `**/*.ts`, `**/*.tsx` 전체에 적용. (타입 인지 규칙은 모노레포 전역 tsconfig 참조 설정이 필요해 비용이 커서 최소 구성 범위에서 제외 — 필요 시 후속 과제)
- `apps/web/**`에는 `react-hooks/exhaustive-deps`(warn), `react-hooks/rules-of-hooks`(error) 추가 적용.
- `no-explicit-any`는 warn으로 완화(Nest DI/zod 파싱 결과 등 불가피한 사례 존재).
- 루트 `package.json`의 `lint` 스크립트를 `pnpm -r lint`(각 워크스페이스에 `lint` 스크립트가 없어 조용히 통과하던 위양성 원인) → `eslint .`(레포 전체를 flat config 하나로 직접 검사)로 변경.

**검증**: `pnpm lint` 실행 결과 실제 규칙이 동작함을 확인했고, 다음 2건의 실질적 오류를 이번 기회에 함께 수정했다(둘 다 회귀 테스트 46/46 재실행으로 무영향 확인):

| 파일 | 문제 | 조치 |
|---|---|---|
| `apps/api/src/evaluation/evaluation.service.ts:85` | `let rangeErrors`가 재할당되지 않음(`prefer-const`) | `const`로 변경 |
| `apps/web/src/components/ItemDetailSections.tsx:113` | 기존 `// eslint-disable-next-line react-hooks/exhaustive-deps` 주석이 미구성 규칙을 참조해 "정의되지 않은 규칙" 오류 발생 | `eslint-plugin-react-hooks` 추가로 규칙을 실제로 구성해 주석이 유효해지도록 수정 |

최종 `pnpm lint` 결과: **0 error, 11 warning**(전부 테스트 파일의 `any` 사용 등 의도된 완화 대상), exit code 0. 남은 warning은 차단 사유 아님(TODO로 남김, 필요 시 후속 Phase에서 정리).

### 2.5 CORS 전체 허용 (L-3) — 정보성, 조치 없음

`apps/api/src/main.ts`의 `app.enableCors()`는 옵션 없이 호출되어 모든 origin을 허용한다. 현재 로컬/사내 개발 단계에서는 문제 없으나, **Phase 6(CI/배포)에서 화이트리스트 적용 필요**(예: `enableCors({ origin: [...] })`, 배포 도메인 확정 후). 이번 Phase에서는 지시에 따라 조치하지 않음.

### 2.6 stale 빌드 산출물 (N-3) — 확인 결과: 해당 없음

`apps/api/dist/__verify-contract.{js,d.ts,js.map}` 존재 여부를 확인했으나 **현재 저장소에는 해당 파일이 없음**(1차 리뷰 이후 이미 정리되었거나 재현되지 않음). `apps/api/dist/`는 `.gitignore`에 포함되어 있어 git 추적에는 애초에 영향 없음. 추가 조치 불필요.

## 3. 변경 파일 목록

| 파일 | 변경 내용 |
|---|---|
| `apps/api/package.json` | `dev`, `typecheck` 스크립트 추가 (L-9, L-13 회피) |
| `apps/api/src/evaluation/evaluation.service.ts` | `let rangeErrors` → `const` (ESLint `prefer-const` 오류 수정) |
| `package.json` (루트) | `lint` 스크립트를 `eslint .`로 변경, `eslint`/`typescript-eslint`/`eslint-plugin-react-hooks` devDependency 추가 |
| `pnpm-lock.yaml` | 위 devDependency 추가에 따른 lockfile 갱신 |
| `eslint.config.js` (신규) | 모노레포 전체 최소 ESLint flat config (M-7) |
| `docs/deploy/phase1-deploy.md` (신규, 본 문서) | 실행 절차/시나리오/이슈 정리 |

커밋은 수행하지 않았다(git-manager 담당, 사용자 승인 필요 — CLAUDE.md 컨벤션 및 PM 지시 준수).

## 4. 알려진 제약사항 / 후속 과제

- **Docker/CI 인프라 미구축**: `infra/**`, `.github/workflows/**` 없음. Phase 6에서 신규 작성 예정(docker-compose로 api/web/postgres 분리, dev는 SQLite 유지 방침).
- **`/health` 엔드포인트 부재**: 현재는 `POST /transcripts` 왕복으로 대체 확인. Docker 헬스체크/CI 도입 전 추가 권고.
- **CORS 전체 허용**: 로컬 단계에서는 무해하나 배포 전 화이트리스트 필요(L-3, Phase 6).
- **Windows `prisma generate` EPERM**: dev 서버 종료 후 실행하는 것으로 회피(코드 결함 아님, 근본 해결 불가). `typecheck` 스크립트로 일상적 타입 검증은 우회 가능.
- **ESLint warning 11건 잔존**: 테스트 파일의 `any` 사용 등, 차단 사유 아님. 필요 시 후속 정리.
- **M-3/M-4/N-1/N-2 등 재리뷰 잔존 이슈**: 본 문서의 범위(deployment-engineer 참고사항으로 이관된 M-7/L-9/L-13/L-3/N-3)가 아니므로 다루지 않음 — `docs/review/phase1-vertical-slice-review-round2.md`의 후속 과제 표를 참조.
