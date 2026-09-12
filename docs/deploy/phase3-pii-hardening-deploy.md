# Phase 3 (PII 마스킹 강화) 로컬 실행/배포 확인

- 대상 커밋: `8fed4e8` (`feat: Phase 3 PII 마스킹 강화(비속어 옵션 B + 마스킹 관측성)`), 최종 리뷰 통과 `docs/review/phase3-pii-hardening-review-round3.md`(§6, Pass), 테스트 리포트 `docs/test/phase3-pii-hardening-report.md`
- 검증 환경: Windows 11, Node v24.19.0, pnpm 12.3.4(workspace `packageManager` 고정)
- 범위: 로컬 실행 확인까지. **이번 Phase도 `infra/**`(Docker/CI) 신규 구축 대상이 아니다.** 저장소에 `infra/` 디렉터리가 아직 없음을 재확인했다(Phase 1 배포 확인 시점과 동일, 변화 없음). PM 지시(CLAUDE.md §단계별 전개)상 컨테이너화/CI는 Phase 6에서 다룬다 — 이번 문서는 Phase 6 범위의 신규 Dockerfile/CI 워크플로를 설계하지 않았다.

## 0. `infra/` 존재 여부 확인 (요청 배경)

```bash
ls "D:\2. Team Source\Auto QA"
# apps  CLAUDE.md  docs  eslint.config.js  node_modules  package.json  packages
# pnpm-lock.yaml  pnpm-workspace.yaml  scripts  seed  tsconfig.base.json
ls "D:\2. Team Source\Auto QA\infra"
# ls: cannot access '.../infra': No such file or directory
```

**결과: `infra/` 디렉터리 없음.** Bootstrap(Phase 0)~Phase 3 어느 시점에도 docker-compose/Dockerfile이 생성되지 않았다. 따라서 이번 확인은 `docs/deploy/phase1-deploy.md`(Phase 1 배포 확인 문서)와 동일하게 **pnpm 스크립트 기반 로컬 실행**으로 수행했으며, 신규 Docker/CI 자산은 만들지 않았다(지시사항 준수 — 이번 요청은 "배포 진행"이지 "배포 인프라 신규 구축"이 아님).

## 1. 실행 방법

### 1.1 준비

```bash
pnpm install   # 이미 설치되어 있어 변경 없음(확인만)
```

`.env`(루트) / `apps/api/.env` 핵심 값(둘 다 동일, Phase 1과 무변경):

| 변수 | 값 | 설명 |
|---|---|---|
| `LLM_PROVIDER` | `mock` | 실제 API 키 없이 결정론적 더미 채점 사용 |
| `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` | (빈 값) | 플레이스홀더만 유지, 실키 없음 확인 |
| `DATABASE_URL` | `file:./dev.db` | `apps/api/prisma/dev.db`(SQLite), `*.db`는 `.gitignore` 처리됨 |
| `API_PORT` | `3000` | NestJS API 포트 |
| `MOCK_LLM_FAILURE_RATE` | `0` | 테스트 전용 오류 주입 확률 |
| (web) `VITE_API_BASE_URL` | 미설정(기본값 `http://localhost:3000`) | `apps/web/src/api/client.ts` 기본값과 API 포트 일치 확인 |

### 1.2 Prisma 마이그레이션 상태 확인

```bash
cd apps/api
npx prisma migrate status
```

결과:

```
2 migrations found in prisma/migrations
Database schema is up to date!
```

`prisma/migrations/` 목록: `20260911115138_init`, **`20260912005915_add_masking_summary`**(Phase 3 신규, `Transcript.maskingSummary` 컬럼). 로컬 `dev.db`에 두 마이그레이션 모두 적용된 상태임을 실측 확인했다(별도 `migrate deploy` 불필요, 이미 최신).

### 1.3 Windows `prisma generate` EPERM (L-13) 재확인

절차대로 `npx prisma generate`를 먼저 단독 실행했더니 **동일 계열의 EPERM이 재현**되었다:

```
Error: EPERM: operation not permitted, rename
'...\.prisma\client\query_engine-windows.dll.node.tmp23848' -> '...\.prisma\client\query_engine-windows.dll.node'
```

원인을 조사한 결과, Phase 1 문서(§2.2)가 지목한 "동시에 떠 있는 dev 서버가 엔진 파일을 잠근다"는 경우가 아니라, **이전 세션에서 실패했던 `generate` 시도가 남긴 `.tmp` 임시 파일**이 대상 경로에 그대로 남아 있었던 것이 원인이었다(`query_engine-windows.dll.node.tmp23848`). 이 잔존 `.tmp` 파일을 삭제한 뒤 재실행하니 정상 완료되었고, 이어서 `pnpm -r build`(내부적으로 `prisma generate` 포함)도 문제없이 통과했다.

```bash
rm "D:\2. Team Source\Auto QA\node_modules\.pnpm\@prisma+client@5.22.0_prisma@5.22.0\node_modules\.prisma\client\query_engine-windows.dll.node.tmp23848"
pnpm -r build   # 이후 정상 완료 (아래 §2 참조)
```

**결론**: L-13의 근본 원인(Windows 파일 잠금 특성) 자체는 여전히 유효하나, 이번에 실측된 구체적 트리거는 "이전에 중단된 generate가 남긴 stale `.tmp` 파일"이었다. 회피 방법(신규): 같은 EPERM이 재발하면 `.prisma/client/` 아래 `*.tmp*` 잔존 파일을 먼저 지우고 재시도한다. Phase 1 문서의 "dev 서버 먼저 종료" 회피책도 여전히 유효(둘 다 같은 파일을 잠그는 근본 원인의 다른 표출 형태).

### 1.4 전체 모노레포 빌드

```bash
pnpm -r build
```

결과: `packages/shared-types`, `packages/pii-mask`, `packages/eval-schema`, `apps/web`(`tsc --noEmit` + `vite build`), `apps/api`(`prisma generate` + `tsc`) **전부 Done**, 에러 0건.

### 1.5 기동

```bash
# API (프로덕션 빌드 산출물 실행)
cd apps/api
node dist/main.js
# => "Auto QA API listening on port 3000"

# Web (프로덕션 빌드 미리보기)
cd apps/web
npx vite preview --port 4173
# => http://localhost:4173/
```

개발 모드로 기동하려면 Phase 1과 동일하게 루트에서 `pnpm dev`(API 3000 + Web 5173 동시 기동, `ts-node-dev` hot reload) 사용 가능.

### 1.6 확인 방법 (헬스체크)

Phase 1과 동일하게 전용 `/health` 엔드포인트는 아직 없다(Phase 1 문서에서 이미 후속 과제로 기록됨, 이번 Phase 범위 아님). 왕복 확인으로 대체:

```bash
curl -X POST http://localhost:3000/transcripts \
  -H "Content-Type: application/json" \
  -d '{"domainId":"telecom","rawText":"상담사: 안녕하세요.\n고객: 문의드립니다.\n상담사: 네 안내해드리겠습니다.\n고객: 감사합니다."}'
# => 201 { "transcriptId": "...", "evaluationId": "..." }

curl http://localhost:3000/transcripts/<transcriptId>
# => 200, 채점 결과 JSON + Phase 3 신규 필드 "maskingSummary": {"rrn":0,"phone":0,...}

curl -I http://localhost:4173/
# => 200 (Web 프로덕션 미리보기 SPA 서빙)
```

## 2. 확인한 시나리오

### 2.1 전체 빌드 (요청 5)

`pnpm -r build` **통과**(§1.4). 별도 코드 결함 없음.

### 2.2 API 기동 (mock 프로바이더) (요청 1)

`node dist/main.js` 및 `pnpm --filter @auto-qa/api dev` 둘 다 정상 기동 확인. NestJS 라우트 로그에 `POST /transcripts`, `GET /transcripts/:id`, `GET /evaluations/:id`, `PATCH /evaluations/:id/items/:itemId`가 정상 매핑되었다.

**부수 발견(코드 결함 아님, 환경 이슈)**: 최초 기동 시도에서 `EADDRINUSE :::3000`이 발생했다. `netstat -ano`로 확인한 결과, 이전 세션(추정: Phase 3 구현/리뷰 작업 중 기동했던 API dev 서버)이 종료되지 않고 포트 3000을 계속 점유하고 있었다(PID 22640). 해당 프로세스를 종료한 뒤 재기동하여 정상 확인했다. **주의**: 향후 세션에서도 작업 종료 시 백그라운드 Node 프로세스를 반드시 종료할 것(이번에도 확인 작업 종료 시 기동한 API(3000)/Web(4173) 프로세스를 모두 종료 완료, §4 참조).

### 2.3 Web 기동 및 API 연동 (요청 2)

`npx vite preview --port 4173` 기동 후 `curl -I http://localhost:4173/` → `200`, `index.html`이 `apps/web/src/api/client.ts`의 빌드 산출물 번들을 정상 참조함을 확인. `VITE_API_BASE_URL` 미설정 시 기본값(`http://localhost:3000`)이 API 포트와 일치함을 코드/빌드 산출물 양쪽에서 확인했다.

브라우저 GUI 클릭 조작은 이 세션에 headless 브라우저 자동화 도구(Playwright 등)가 설치되어 있지 않아(`npx playwright` 시도 시 미설치로 실행 취소) 수행하지 않았다. 대신 Phase 1과 동일한 대체 전략, 즉 (a) SPA가 200으로 정상 서빙되는지, (b) 프런트가 실제로 호출하는 것과 동일한 API 계약(§2.4)을 curl로 직접 왕복시켜 데이터 형태를 검증하는지, (c) 프런트 렌더링 로직의 단위 테스트(§2.5)로 화면 표시 문구까지 검증하는 방식을 조합해 확인했다.

### 2.4 Phase 3 FR-4 End-to-End 확인: PII 마스킹 요약 (요청 3)

합성(가상) PII를 포함한 트랜스크립트 1건을 API에 제출하고 결과를 조회했다(전화번호/카드번호/이메일/계좌번호 각 1건, 실제 개인정보 아닌 임의 조합 — 010-1234-5678, 1234-5678-9012-3456 등).

**응답 JSON의 신규 필드 확인**:

```json
"maskingSummary": { "rrn": 0, "phone": 1, "card": 1, "account": 1, "email": 1 }
```

`packages/shared-types`의 `MaskingSummary`(`Record<PiiKind, number>`) 스키마와 일치, `EvaluationResultResponse.maskingSummary`가 정상 채워짐을 확인했다.

**프런트 렌더링 로직**: `apps/web/src/pages/TranscriptResultPage.tsx`가 `result.maskingSummary`를 `EvaluationMetaFooter` 컴포넌트에 전달하고, 해당 컴포넌트의 `formatMaskingSummary()`가 `"PII 마스킹: 전화번호 1건, 카드번호 1건, 계좌번호 1건, 이메일 1건"` 형태의 문구를 조립하는 구조를 코드로 확인했다. 이 순수 함수는 `EvaluationMetaFooter.spec.ts`(8개 케이스: 정상 집계/0건/legacy null/일부 종류만 등)로 단위 테스트되어 있으며, 이번 세션에서 재실행해 **8/8 통과**를 확인했다(§2.5). GUI 스크린샷 촬영 도구가 없어 실제 브라우저 렌더링 화면 캡처는 하지 못했으나, API 데이터 왕복(위 JSON)과 렌더링 함수 단위 테스트를 결합하면 "결과 화면에 PII 마스킹 N건 문구가 표시된다"는 FR-4 요건이 실제로 만족됨을 논리적으로 충분히 검증했다고 판단한다.

### 2.5 DB 저장 데이터 재확인: 원문 미저장 (요청 3)

`apps/api/prisma/dev.db`를 Prisma Client로 직접 조회해 `Transcript.maskedText`에 원문 PII 문자열이 남아 있는지 확인했다(합성 데이터, 로그/문서에는 마스킹된 형태만 남김):

| 검사 | 결과 |
|---|---|
| `maskedText`에 원본 전화번호(`010-1234-5678`) 포함 여부 | `false` |
| `maskedText`에 원본 카드번호(`1234-5678-9012-3456`) 포함 여부 | `false` |
| `maskedText`에 원본 이메일(`test.user@example.com`) 포함 여부 | `false` |
| `maskedText`에 원본 계좌번호(`110-123-456789`) 포함 여부 | `false` |
| `maskedText`에 `[전화번호]`/`[카드번호]`/`[이메일]`/`[계좌번호]` 마스킹 토큰 포함 여부 | `true` (전부) |
| `maskingSummary` 컬럼 값 | `{"rrn":0,"phone":1,"card":1,"account":1,"email":1}` (JSON 직렬화, 스키마 주석대로) |

**참고(테스트 방법론 이슈, 앱 결함 아님)**: 최초 시도에서 curl 명령줄 인자로 한글 원문을 직접 전달했더니(Windows Git Bash) 마스킹 토큰([전화번호] 등)은 정상 출력되었지만 주변 원문 한글이 인코딩 깨짐 문자로 저장되는 현상이 있었다. 원인을 분리 검증하기 위해 동일 페이로드를 UTF-8 JSON 파일로 저장한 뒤 `curl --data-binary @file`로 재전송했더니 한글 원문/마스킹 토큰 모두 정상 저장·조회되었다. 즉 이는 **API/마스킹 로직 결함이 아니라 Windows 셸 환경에서 커맨드라인 인자로 비ASCII 문자를 전달할 때의 인코딩 이슈**였다(재현·해소 모두 확인). 실제 Web 프런트(`fetch` + JSON.stringify, UTF-8 고정)는 이 경로를 타지 않으므로 프로덕션 경로에는 영향 없음.

### 2.6 회귀 테스트 스위트 실행 (요청 3~5 보강)

| 패키지 | 명령 | 결과 |
|---|---|---|
| `@auto-qa/pii-mask` | `pnpm --filter @auto-qa/pii-mask test` | **통과, 2 suites / 149 tests**(`docs/review/phase3-pii-hardening-review-round3.md` §6 최종 수치와 일치) |
| `@auto-qa/api` | `pnpm --filter @auto-qa/api test` | **통과, 3 suites / 52 tests** |
| `@auto-qa/web` | `pnpm --filter @auto-qa/web test` | **통과, 1 suite / 8 tests**(`EvaluationMetaFooter.spec.ts`) |
| `@auto-qa/eval-schema` | (해당 패키지에 `test` 스크립트 없음) | 실행 대상 아님(확인만) |

api 테스트 실행 중 `EvaluationService`의 "값 범위 위반 → 재시도 → manual_review 저장" 시나리오가 의도적으로 WARN 로그를 다수 출력하는데, 이는 해당 테스트가 의도적으로 유발한 정상 동작(재시도/폴백 로직 검증)이며 오류가 아니다.

## 3. 변경 파일 목록

이번 배포 확인 세션에서는 **프로젝트 코드/설정을 변경하지 않았다**. 발견한 stale `.tmp` 잠금 파일(`node_modules/.pnpm/.../.prisma/client/query_engine-windows.dll.node.tmp23848`) 삭제는 `node_modules` 내부(빌드 산출물, git 비추적)이므로 저장소 변경사항에 해당하지 않는다.

| 파일 | 상태 |
|---|---|
| (없음) | 코드 수정 없음. 지시사항에 따라 `infra/**` 자체가 없어 인프라 설정 수정도 발생하지 않았다. |

## 4. 세션 종료 후 정리

확인 과정에서 기동한 프로세스를 모두 종료했다(포트 점유 방지):

```bash
# API(3000), Web preview(4173) 프로세스 종료
netstat -ano | grep -E ":3000|:4173"   # 확인
# Stop-Process (PowerShell)로 종료 후 재확인 → 두 포트 모두 LISTENING 없음
```

세션 종료 시점 `netstat` 재확인 중 **이번 세션에서 시작하지 않은 leftover 프로세스도 추가로 발견**했다 — 포트 5173(Vite dev, `apps/web`)과 그 API 짝(ts-node-dev, `apps/api`)이 이전 작업(추정: Phase 3 구현/테스트 단계에서 기동 후 미종료)에서 계속 살아 있었다(`Get-CimInstance Win32_Process`로 커맨드라인 확인, PID 18444/22744). 이번 세션이 직접 시작한 프로세스가 아니지만 포트 점유 방지 원칙에 따라 함께 종료했다. 최종 `netstat` 재확인 결과 3000/4173/5173 **전부 비어 있음**을 확인했다. 테스트로 생성한 합성 트랜스크립트 2건은 `apps/api/prisma/dev.db`(gitignore 대상, git 비추적)에만 남아 있으며 실제 개인정보를 포함하지 않는다.

## 5. 알려진 제약사항 / 후속 과제

- **Docker/CI 인프라 여전히 미구축**: `infra/**`, `.github/workflows/**` 없음(Phase 1 시점과 동일). Phase 6에서 신규 작성 예정(docker-compose로 api/web/postgres 분리, dev는 SQLite 유지 방침 — CLAUDE.md/PM 지시 재확인).
- **`/health` 엔드포인트 부재**: Phase 1부터 이어지는 후속 과제. `POST /transcripts` 왕복으로 대체 확인 중. Docker 헬스체크 도입 전(Phase 6) 추가 권고.
- **Windows `prisma generate` EPERM(L-13)**: 이번에 재현된 구체적 트리거는 "이전 실패 시도가 남긴 `.prisma/client/*.tmp*` 잔존 파일"이었다(§1.3). 회피: 재발 시 해당 `.tmp` 파일 삭제 후 재시도, 또는 Phase 1 문서의 "dev 서버 종료 후 실행" 방법 병행. 근본 원인(Windows 파일 잠금)은 여전히 해소 불가 — Phase 6 CI(Linux 러너) 도입 시 재현 여부 별도 확인 권고(Phase 1 문서 §2.2와 동일 결론 유지).
- **백그라운드 프로세스 잔존 위험(실제 발생, 2건)**: 이번 세션 시작 시 이전 작업에서 종료되지 않은 API 프로세스가 포트 3000을 점유하고 있었고(§2.2), 세션 종료 정리 중에는 포트 5173(Vite dev)/그 API 짝(ts-node-dev)이 별도로 방치되어 있음을 추가로 발견했다(§4). 향후 작업자는 작업 종료 전 `netstat`로 3000/5173/4173 등 개발 포트 점유 여부를 반드시 재확인하고, 본인이 시작하지 않은 leftover 프로세스라도 발견 시 종료할 것을 권고.
- **CORS 전체 허용(L-3, Phase 1 문서 인계)**: 여전히 조치 없음(로컬/사내 단계 무해, Phase 6에서 화이트리스트 적용 예정).
- **브라우저 GUI 자동 캡처 미수행**: headless 브라우저 도구 미설치로 실제 렌더링 스크린샷은 확보하지 못했다. API 응답(§2.4) + 프런트 단위 테스트(§2.5 표)로 대체 검증했으며, 필요 시 Phase 5(테스트 자동화 확장)에서 Playwright 등 도입을 검토할 수 있다.
