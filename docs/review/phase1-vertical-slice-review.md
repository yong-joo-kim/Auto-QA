# Phase 1 Vertical Slice — 코드 리뷰

## 1. 검토 범위

커밋 이전 상태(working tree 전체). 참조 문서: `CLAUDE.md`, `docs/requirements/phase1-vertical-slice.md`, `docs/architecture/eval-sheet-schema.md`.

- `apps/api/**` (main, app.module, transcripts, evaluation, eval-sheets, prisma, llm providers, dto)
- `apps/api/prisma/schema.prisma`, `migrations/20260911115138_init/migration.sql`, `dev.db`(내용 스캔)
- `packages/shared-types/src/index.ts`, `packages/eval-schema/src/{schema,loader,index}.ts`, `packages/pii-mask/src/{mask,profanity}.ts`
- `apps/web/src/**` (pages 2, components 15, api/client, domain/domains)
- `seed/eval-sheets/*.json` 10종, `.env` / `.env.example` / `.gitignore`, 워크스페이스 매니페스트

**검증 방법**: 정적 리뷰 + 타입체크/빌드 실행 + 빌드 산출물(`dist`)에 대한 런타임 프로브(마스킹 케이스, Mock 결정론성, `EvaluationService` 계약위반 경로 7종, dev.db 원문 패턴 스캔).

**빌드/린트 결과**

| 명령 | 결과 |
|---|---|
| `pnpm --filter @auto-qa/api exec tsc -p tsconfig.json` | 통과 (0 error) |
| `pnpm --filter @auto-qa/web exec tsc --noEmit` | 통과 (0 error) |
| `pnpm --filter @auto-qa/web exec vite build` | 통과 (185KB / gzip 60KB) |
| `pnpm -r build` | 실패 — `apps/api`의 `prisma generate`가 Windows `EPERM`(query_engine DLL 파일 잠금). 코드 결함 아님, L-13 참조 |
| `pnpm lint` | no-op — ESLint 설정·스크립트가 어디에도 없음 (M-7) |

## 2. 중점 항목 요약 판정

| 중점 항목 | 판정 |
|---|---|
| 1. PII 처리(원문 비저장/비전송/비로그) | 통과 |
| 2. 배점 무결성(서버 재계산, maxScore 초과 차단) | 조건부 통과 — 정상 경로는 견고, 비정상 응답 보정에 결함(H-1, M-1) |
| 3. 게이팅 로직 | 통과 |
| 4. API 키/비밀정보 | 통과 |
| 5. 에러 처리(400/404/502/manual_review) | 수정 필요 (H-1, H-2) |
| 6. 프론트-백 타입 일치 | 통과 (경미한 중복 M-8, L-6, L-14) |
| 7. 일반 코드 품질 | 양호 (과도한 추상화 없음) |
| 8. Mock 결정론성 | 통과 (실측 확인, 단 L-7) |

**검증된 긍정 사항**: 원문 비저장(DB 바이너리 스캔), 서버측 총점 재계산, 게이팅 우선판정, 비밀키 비노출, Mock 결정론성, Provider 추상화, 프론트의 `@auto-qa/shared-types` 재사용 — 모두 실측 확인됨.

## 3. 발견 사항

### High

**H-1. `sanitizeForManualReview`의 clamp가 NaN을 통과시켜 `totalScore=NaN`이 DB에 저장됨**
`apps/api/src/evaluation/evaluation.service.ts:156` — `Math.round(undefined)`→`NaN`이 clamp를 그대로 통과. 실제 프로바이더가 `score`를 누락/문자열로 반환하면 `totalScore=NaN` 저장, 등급이 무조건 "미흡"으로 산출됨. 권고: `Number.isFinite` 가드 후 실패 시 0으로 대체.

**H-2. `coaching`/`profanityCheck` 계약이 전혀 검증되지 않아 502 대신 500(TypeError)이 발생**
`apps/api/src/evaluation/evaluation.service.ts:83-85, 111-127` — 필수 필드인데 검증 대상이 아니며 즉시 역참조되어 TypeError. 구조적 위반이므로 NFR-3.3에 따라 502여야 함. 또한 `coaching.goodPoints=[]`(빈 배열)이 오류 없이 통과해 AC-12 위반. 권고: 응답 검증을 zod로 통합, coaching/profanityCheck 구조 검사 추가.

### Medium

- **M-1** `score` 정수 검증 누락 — 소수값이 그대로 통과해 `Int` 컬럼 저장 시 실패/절삭 위험 (`evaluation.service.ts:138`)
- **M-2** `reason` 미검증 → UI에 "배점 사유: undefined" 노출 가능 (`evaluation.service.ts:129-146`, `ItemDetailSections.tsx:82`)
- **M-3** 비속어 오탐 — 부분 문자열 매칭으로 "새끼손가락" 등이 오탐됨 (`packages/pii-mask/src/profanity.ts:23-38`)
- **M-4** 계좌번호 정규식 과탐 — 날짜/주문번호/유선전화가 `[계좌번호]`로 파괴됨 (`packages/pii-mask/src/mask.ts:51-55`)
- **M-5** LLM 호출 실패 시 에러 정보 완전 소실(로깅 전무) — 바인딩 없는 `catch` (`evaluation.service.ts:91-98`)
- **M-6** 평가시트 배점 합계 불변식 미검증 — Excel 오타로 합계 불일치 시 무경고 통과 (`packages/eval-schema/src/schema.ts:17-42`)
- **M-7** 린트 도구 전혀 미구성 — `pnpm lint`가 위양성 통과
- **M-8** 프론트/백엔드에 검증 상수(`MIN_NON_WHITESPACE_LENGTH` 등) 중복 정의 — drift 위험

### Low

L-1~L-14: 점 구분자 전화번호 미탐지, 하이픈 없는 RRN 미탐지, CORS 전체허용(Phase6에서 화이트리스트 필요), 과거 평가 재조회 시 시트 근거 문구 뒤바뀜, `consultedAt` 입력 UI 없는 dead state, `ApiErrorResponse.message` 타입 불일치, Mock `latencyMs` 비결정론적(스냅샷 테스트 주의), 미사용 `/evaluations/:id`, 루트 `pnpm dev`가 API를 안 띄움(`apps/api`에 `dev` 별칭 필요), `schema-builder.ts` 미사용 코드, env 변수 문서화 누락, **요구사항 문서 AC-1의 "13건"이 실제 시트 기준 "14건"으로 정정 필요**, `apps/api` Windows `prisma generate` EPERM(별도 typecheck 스크립트 권고), `EvaluationMetaFooter`의 느슨한 타입.

## 4. 종합 의견

**판정: 수정 필요 (conditional)** — 핵심 설계 원칙(원문 비저장/서버 재계산/게이팅 우선/비밀키/Provider 추상화/Mock 결정론성)은 모두 실측으로 통과했으나, "LLM 응답이 계약을 벗어났을 때"의 방어선에 구멍이 있다(H-1, H-2). Mock만 쓰는 Phase 1에서는 드러나지 않다가 Phase 4 실제 LLM 연동 시 데이터 손상으로 터질 수 있어 지금 고치는 것이 저렴하다.

### 재작업 요청 (우선순위 순)

**backend-implementer — 필수(머지 차단)**: H-1, H-2, M-1, M-2, M-5
**backend-implementer — 권고**: M-3, M-4, M-6, M-8
**requirements-analyst**: L-12 (13건→14건 정정)
**test-automation 참고**: L-7, L-11, 계약위반 7종 회귀테스트화
**deployment-engineer 참고**: M-7, L-9, L-13, L-3

H-1/H-2/M-1/M-2 수정 후 재리뷰를 거치면 test-automation 단계로 진행 가능.
