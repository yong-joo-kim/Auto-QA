# Gemini LLM Provider 실연동 — 로컬 실행/배포 확인

- 대상 커밋: `db04610` (`feat: Gemini LLM 프로바이더 실연동 완료`)
- 관련 문서: `docs/requirements/gemini-llm-provider.md`, `docs/decisions/ADR-001-gemini-llm-provider.md`
- 검증 환경: Windows 11, Node v24.19.0, pnpm 12.3.4(workspace `packageManager` 고정)
- 범위: PM 런북(CLAUDE.md) 8단계 중 마지막 단계 — **로컬 실행 경로에서 이번 기능이 정상 동작하는지 확인**. 새 인프라(`infra/**`, `.github/workflows/**`)를 신설하는 작업이 아니다.

## 0. 인프라 현황 재확인 (범위 정정)

`docs/deploy/phase1-deploy.md`에 이미 기록된 대로, 이 저장소에는 아직 `infra/` 디렉터리와 `.github/workflows/`가 **존재하지 않는다**(2026-09-13 재확인, `find` 결과 0건). `docker-compose.yml`/`Dockerfile.api`/`Dockerfile.web`은 CLAUDE.md의 단계별 전개표상 **Phase 6(CI/배포)**에서 신규 작성하도록 계획되어 있으며, 이번 기능(`gemini-llm-provider`)은 Phase 번호가 없는 애드혹 기능으로 그 범위에 포함되지 않는다.

따라서 이번 라운드는 다음으로 범위를 한정했다:

- 기존 `pnpm dev` / `node dist/main.js` 로컬 실행 경로에서 Gemini 프로바이더 통합이 회귀 없이 동작하는지 확인.
- Docker Compose 기동 확인은 **infra가 없으므로 수행하지 않음**(수행 대상 자체가 없음). Phase 6에서 `docker-compose.yml` 신설 시 이번에 확인한 env 계약(`LLM_PROVIDER`, `GEMINI_*`)을 그대로 반영할 것을 권고사항으로 남긴다.

## 1. 확인 결과 요약

| 항목 | 결과 |
| --- | --- |
| AC-10: `LLM_PROVIDER=mock`(기본값) 정상 기동 | **통과** — §2.1 |
| AC-6: `LLM_PROVIDER=gemini` + 키/모델 누락 시 fail-fast | **통과** — §2.2 |
| AC-7 관련: 비밀키 비노출(로그/에러 메시지) | **통과** — §2.2, §2.3 |
| `pnpm --filter @auto-qa/api test` 전체 그린 | **통과** — 120/120, §2.4 |
| `pnpm --filter @auto-qa/pii-mask test` 전체 그린 | **통과** — 149/149, §2.4 |
| `pnpm --filter @auto-qa/api build` 정상 | **통과** — 오류 없이 `prisma generate` + `tsc` 완료, §2.5 |
| Docker Compose 로컬 기동 | **해당 없음** — `infra/`가 아직 없음(Phase 6 범위), §0 |
| `.env.example` Gemini 절 반영 | **통과** — 육안 확인, §2.6 |

실제 Gemini API를 호출하는 end-to-end 채점(AC-1)은 이번 배포 확인 범위에 포함하지 않았다(PM 지시: "가짜 키로 fail-fast 경로만 확인, 진짜 API 키 필요한 e2e는 범위 밖"). `.env`에 `GEMINI_API_KEY`가 실제로 설정되어 있고 `LLM_PROVIDER=mock`이 유지되고 있음을 값 노출 없이 존재 여부만 확인했다(§2.3).

## 2. 상세 확인 내역

### 2.1 AC-10 — `LLM_PROVIDER=mock` 정상 기동(회귀 없음)

```bash
cd apps/api
LLM_PROVIDER=mock node dist/main.js
```

로그에 `[EvaluationModule] LLM provider: mock`이 출력되고 `Nest application successfully started` 후 포트 3000에서 정상 리스닝했다. `curl http://localhost:3000/transcripts/nonexistent-id` 요청에 `404`로 응답해(존재하지 않는 리소스에 대한 정상적인 애플리케이션 레벨 응답) 서버가 실제로 라우팅까지 살아있음을 확인했다. Gemini 관련 env를 전혀 주지 않은 상태에서도 정상 기동했다(FR-8.3 재확인).

### 2.2 AC-6 — 설정 누락 시 fail-fast (실제 재현)

**Test A: `GEMINI_API_KEY` 누락**

```bash
LLM_PROVIDER=gemini GEMINI_API_KEY= GEMINI_MODEL=gemini-3.8-flash node dist/main.js
```

결과: 기동 즉시 실패, 프로세스 종료 코드 `1`.

```
[ExceptionHandler] LLM_PROVIDER=gemini이지만 GEMINI_API_KEY가 설정되지 않았습니다. .env를 확인하세요.
```

**Test B: `GEMINI_MODEL` 누락**

```bash
LLM_PROVIDER=gemini GEMINI_API_KEY=dummy-fake-key-for-fail-fast-test GEMINI_MODEL= node dist/main.js
```

결과: 기동 즉시 실패.

```
[ExceptionHandler] LLM_PROVIDER=gemini이지만 GEMINI_MODEL이 설정되지 않았습니다. .env를 확인하세요.
```

두 케이스 모두 에러 메시지·스택트레이스에 키 값(`dummy-fake-key-for-fail-fast-test` 포함)이 전혀 출력되지 않았다(로그 전문을 `grep`으로 재확인, 0건 일치). 한국어로 원인이 명확히 안내되어 `.env`를 확인하도록 유도한다(FR-8.1/8.2/AC-6 요구사항 그대로 충족).

### 2.3 비밀키 비노출 확인 (실제 `.env` 대상)

실제 `.env` 파일의 값을 `cat`하거나 로그에 출력하지 않고, 존재 여부만 `grep -c`로 확인했다.

| 확인 항목 | 결과 |
| --- | --- |
| `GEMINI_API_KEY=`(비어있지 않은 값) 존재 | 1건 (설정됨) |
| `ANTHROPIC_API_KEY=`(비어있지 않은 값) 존재 | 0건 (미설정, 정상 — Anthropic은 스텁) |
| `LLM_PROVIDER` 현재값 | `mock` |
| `GEMINI_MODEL` 현재값 | `gemini-3.8-flash` (ADR-001 D-1 확정값과 일치) |

이번 세션에서 실제 `GEMINI_API_KEY` 값을 화면에 출력하거나 문서에 기록한 적이 없다(fail-fast 재현에는 `dummy-fake-key-for-fail-fast-test`라는 명백히 가짜인 문자열만 사용).

### 2.4 테스트 스윗 회귀 확인

```bash
pnpm --filter @auto-qa/api test
# Test Suites: 8 passed, 8 total / Tests: 120 passed, 120 total

pnpm --filter @auto-qa/pii-mask test
# Test Suites: 2 passed, 2 total / Tests: 149 passed, 149 total
```

`gemini-llm-evaluation.provider.spec.ts`, `gemini-schema-builder.spec.ts`, `http-retry.spec.ts`, `env-utils.spec.ts`가 스텁 트랜스포트(`GEMINI_API_BASE_URL` 오버라이드 방식) 기반으로 정상/구조 위반/값 범위 위반/429·503·400/타임아웃/안전 필터 차단/JSON 파싱 실패/헤더에 부적합한 키 문자열 케이스를 모두 커버하며 그린임을 확인했다. 테스트 로그에도 `[REDACTED]`로 치환된 문구만 나타나고 실제 키 문자열은 노출되지 않았다(§AC-7 자동 테스트 레벨 확인).

기본 `pnpm test`(mock 경로 포함 전체)는 실제 네트워크 호출 없이 완료되어 AC-10의 "기본 `pnpm test`는 실 Gemini API를 호출하지 않는다" 조건도 재확인되었다.

### 2.5 프로덕션 빌드 확인

```bash
pnpm --filter @auto-qa/api build
# == prisma generate && tsc -p tsconfig.json
```

`prisma generate`가 정상 완료되었고(Prisma Client v5.22.0), 이어지는 `tsc` 컴파일이 오류 없이 종료되었다(`dist/main.js` 및 `dist/evaluation/**` 산출물 생성 확인). 이 `dist/main.js`를 §2.1/§2.2의 실제 기동 확인에 그대로 사용했다.

### 2.6 `.env.example` 육안 확인

`.env.example`(루트)에 다음이 플레이스홀더/기본값과 함께 반영되어 있음을 확인했다(값 자체는 비밀이 아니므로 문서에 그대로 인용 가능):

```
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.8-flash
GEMINI_TIMEOUT_MS=60000
GEMINI_MAX_RETRIES=2
GEMINI_MAX_OUTPUT_TOKENS=8192
GEMINI_TEMPERATURE=0
GEMINI_API_BASE_URL=
GEMINI_THINKING_BUDGET=
LLM_PROVIDER=mock
```

`GEMINI_API_KEY`는 빈 값으로 유지되어 있고(FR-11.1 준수), `GEMINI_MODEL` 기본값은 ADR-001 D-1에서 실측 확정한 `gemini-3.8-flash`와 일치한다. 각 선택 env에는 근거/주의사항 주석이 달려 있어 별도 설명 문서 없이도 운영자가 조정 가능하다.

## 3. 실행 방법 (재현 절차 요약)

```bash
# 1. 의존성 설치 및 Prisma 클라이언트 생성(최초 1회)
pnpm install
pnpm --filter @auto-qa/api exec prisma generate

# 2. .env 준비 (이미 존재하면 생략) — 실제 GEMINI_API_KEY 값은 직접 발급받아 채워 넣는다
cp .env.example .env

# 3. 기본(mock) 개발 기동
pnpm dev
# API: http://localhost:3000 (ts-node-dev, hot reload)
# Web: http://localhost:5173

# 4. Gemini 실 프로바이더로 전환해 보고 싶을 때 (.env에서)
#    LLM_PROVIDER=gemini
#    GEMINI_API_KEY=<발급받은 키>
#    GEMINI_MODEL=gemini-3.8-flash   (또는 gemini-2.5-flash, ADR-001 참고)
# 재기동만 하면 코드 변경 없이 전환된다(AC-10).
```

## 4. 헬스체크 / 확인 방법

Phase 1과 동일하게 전용 `/health` 엔드포인트는 아직 없다(후속 과제로 이월, `docs/deploy/phase1-deploy.md` §1.4 참조). 대신 다음으로 기동 여부를 확인한다.

```bash
curl -X POST http://localhost:3000/transcripts \
  -H "Content-Type: application/json" \
  -d '{"domainId":"telecom","rawText":"상담사: 안녕하세요.\n고객: 문의드립니다.\n상담사: 네 안내해드리겠습니다.\n고객: 감사합니다."}'
# mock: 즉시 201 + 결정론적 더미 채점 결과
# gemini: 수 초~수십 초 후 201 + 실제 LLM 채점 결과, 응답 메타에 llmProvider="gemini"

curl http://localhost:3000/transcripts/<transcriptId>
```

기동 로그의 `LLM provider: <provider> (model=<모델명>)` 한 줄로 어떤 프로바이더가 활성화되었는지 즉시 확인할 수 있다(FR-8.4).

## 5. 알려진 제약사항

1. **Docker/CI 인프라 미구축**: `infra/**`, `.github/workflows/**`가 아직 없다. Phase 6(CI/배포)에서 `docker-compose.yml`(api/web/postgres 분리, dev 기본은 SQLite 유지), `Dockerfile.api`, `Dockerfile.web`을 신규 작성할 때 이번에 확정된 `GEMINI_*`/`LLM_PROVIDER` env 계약을 그대로 compose 환경변수로 반영할 것을 권고한다.
2. **`/health` 엔드포인트 부재**: Phase 1부터 이어지는 제약. `POST /transcripts` 왕복으로 대체 확인 중이며, Docker 헬스체크 도입 전 추가가 필요하다.
3. **실 Gemini API 호출 e2e(AC-1) 미실행**: 이번 라운드는 PM 지시에 따라 가짜 키 기반 fail-fast 경로만 재현했다. 실제 채점 품질/응답 지연(NFR-4.1 P50 30초 목표) 확인은 `.env`에 실제 키를 넣고 `LLM_PROVIDER=gemini`로 수동 전환한 뒤 QA 관리자/개발자가 별도로 1회 이상 수행할 것을 권고한다(ADR-001 D-1/D-9에 이미 기록된 실측치가 참고 자료로 존재).
4. **외부 전송 승인(D-6) 미확정**: ADR-001이 기록한 대로, 마스킹된 상담 텍스트가 Google Gemini 서버로 전송된다는 사실에 대한 사내 데이터 처리 정책상의 최종 승인은 아직 PM/사용자 확인 대기 상태다. 승인 전까지 `gemini` 프로바이더는 로컬 검증 용도로만 사용할 것을 권고한다.
5. **Windows `prisma generate` EPERM**: Phase 1에서 이미 문서화된 환경 이슈(dev 서버 기동 중 `prisma generate` 실행 시 EPERM)로, 이번 검증에서는 dev 서버를 띄우지 않은 상태에서 `build`/`test`를 수행해 문제 없이 완료했다.

## 6. 변경 파일 목록

이번 라운드에서는 코드/설정 변경 없이 검증만 수행했다. 신규 산출물은 본 문서(`docs/deploy/gemini-llm-provider-deploy.md`)뿐이다.

커밋은 수행하지 않았다(git-manager 담당, 사용자 승인 필요 — CLAUDE.md 자동 커밋 금지 원칙 준수).
