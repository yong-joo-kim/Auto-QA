# Phase 1 Vertical Slice — 테스트 리포트

- 대상 문서: `docs/requirements/phase1-vertical-slice.md`, `docs/review/phase1-vertical-slice-review.md`(1차), `docs/review/phase1-vertical-slice-review-round2.md`(재리뷰, 통과 판정)
- 대상 파일: `apps/api/src/evaluation/evaluation.service.ts`, `apps/api/src/evaluation/llm/schema-builder.ts`, `packages/eval-schema/src/schema.ts`
- 목적: 재리뷰 문서 §"test-automation 인계 사항"에 명시된 프로브 시나리오를 회귀 테스트로 고정

## 0. 사전 작업 — 테스트 인프라 구성 (선행 조건)

리포지토리에 테스트 프레임워크가 전혀 구성되어 있지 않았다(어떤 패키지에도 `*.spec.ts`, jest 설정, `test` 스크립트, jest/ts-jest devDependency가 없었음. `apps/web`도 테스트 러너 미구성). 요청 범위("테스트 파일 외 구현 코드는 수정하지 않는다")를 존중하여, 아래는 **애플리케이션 로직이 아닌 테스트 실행에 필요한 최소 인프라**로만 판단해 추가했다(프로덕션 코드/비즈니스 로직 변경 없음):

- `apps/api/package.json`: devDependencies에 `jest`, `ts-jest`, `@types/jest` 추가, `"test": "jest"` 스크립트 추가.
- `apps/api/jest.config.js` 신규 생성(ts-jest, `testRegex: '.*\.spec\.ts$'`).
- `apps/api/tsconfig.json`: `"exclude": ["src/**/*.spec.ts"]` 추가 — 그렇지 않으면 `tsc -p tsconfig.json`(프로덕션 빌드 스크립트)이 스펙 파일까지 `dist/`에 컴파일하여 결과물에 테스트 코드가 섞이는 문제가 있었다(빌드 후 `find apps/api/dist -iname "*.spec.*"`로 무공해 확인함). 이 변경은 컴파일 대상 범위 조정일 뿐 런타임 동작(평가 로직/집계/검증)에는 영향 없음.
- `pnpm install --filter @auto-qa/api...`로 devDependency 설치.

`apps/web`은 테스트 러너 자체가 없어 `pnpm --filter web test`가 무동작(스크립트 없음, exit 0)으로 종료됨을 확인했다. 이번 태스크 범위(evaluation.service.ts/schema-builder.ts/schema.ts)는 전부 `apps/api`·`packages/eval-schema` 쪽이므로 web 쪽 테스트 인프라는 추가하지 않았다(별도 과제로 보고, §5 참고).

## 1. 테스트 범위 및 목록

### 1.1 `apps/api/src/evaluation/evaluation.service.spec.ts` (신규)

`EvaluationService`를 가짜(fake) `LlmEvaluationProvider`와 함께 직접 인스턴스화하여(NestJS DI 컨테이너 없이) 순수 로직을 검증. 테스트용 최소 평가시트(카테고리 2개, 항목 3개 — `item-1`/`item-2`는 일반, `item-3`은 게이팅)를 별도로 구성해 재현성과 가독성을 확보했다.

- **구조적 계약위반 → 502 (BadGatewayException)** — 15종(재리뷰 프로브와 동일 목록):
  coaching 누락 / coaching null / profanityCheck 누락 / goodPoints:[] (AC-12) / goodPoints 4개 / goodPoints가 문자열(배열 아님) / goodPoints:[""] / profanityCheck.detected:true & matches:[] / matches[].speaker enum 위반("bot") / providerMeta 누락 / items 항목 누락 / items 중복 / items 미지 itemId / items가 배열 아님 / 응답 자체가 null.
  각 케이스에서 `BadGatewayException` 발생 및 `getStatus() === 502` 확인.

- **값 범위 위반 → 재시도 후 clamp → `status="manual_review"`** — 13종:
  score 누락 / "5"(문자열) / NaN / null / "abc" / Infinity / 999(배점 초과) / -5(음수) / 3.7(소수), reason 누락 / 공백 / 숫자, 게이팅 항목의 passFail 누락.
  1차·재시도 응답 모두 동일한 위반을 반환하도록 구성하여 "재시도해도 회복 불가" 경로를 검증. 각 케이스에서 `status==="manual_review"`, `Number.isFinite(totalScore)`, 전 항목 `Number.isInteger(score)`, `0<=score<=maxScore`, provider가 정확히 2회(최초+재시도 1회) 호출됨을 확인.

- **재시도 성공 경로**: 1차 범위 위반(score 초과) → 2차(재시도) 정상 응답 → `status="completed"` 유지, 불필요한 `manual_review` 승격 없음, 재시도 응답 값이 그대로 반영됨을 확인. 추가로 "구조 위반은 재시도 대상이 아니라 즉시 502"임을 별도 케이스로 확인(provider가 1회만 호출됨).

- **Mock 결정론성(AC-8)**: `loadEvalSheet('telecom')`(실제 seed, 14개 항목)과 `MockLlmEvaluationProvider`를 사용해 동일 트랜스크립트로 2회 평가 → 항목별 `{itemId, score, reason, passFail}` 배열이 완전히 일치, `totalScore`/`gatingResult`/`grade` 동일. `latencyMs`는 명시적으로 비교 대상에서 제외. 테스트 속도를 위해 `MOCK_LLM_MIN_LATENCY_MS=0`/`MOCK_LLM_MAX_LATENCY_MS=0`/`MOCK_LLM_FAILURE_RATE=0`으로 설정.

### 1.2 `apps/api/src/eval-sheets/eval-sheet-invariants.spec.ts` (신규)

`packages/eval-schema/src/schema.ts`(`evalSheetSchema`)와 `loader.ts`(`loadEvalSheet`, `listSupportedDomainIds`)를 대상.

- **seed 10종 정상 로드**: `listSupportedDomainIds()`가 10개 도메인을 반환하는지, 각 도메인에 대해 `loadEvalSheet(domainId)`가 정상 파싱되고 `domainId` 일치·카테고리 존재·카테고리 배점 합=`totalMaxScore`·항목 배점 합=카테고리 `maxScore`를 만족하는지 확인(`01~10-*.json` 전종 순회).
- **평가시트 불변식 위반 시 거부** — 최소 유효 시트를 기준으로 3종 변조:
  1. 카테고리 내 item.maxScore 합 불일치(`item-1.maxScore`를 999로 변경)
  2. 전체 category.maxScore 합과 totalMaxScore 불일치(`totalMaxScore`를 999로 변경)
  3. category.maxScore만 증가(items/totalMaxScore 미조정) — items 합 불일치와 totalMaxScore 불일치가 동시에 발생하는지까지 확인(`path`에 `categories.0.maxScore`와 `totalMaxScore` 둘 다 포함되는지 검사)
  각 케이스에서 `evalSheetSchema.safeParse(...).success === false` 및 관련 `issue.path` 확인. 대조군(정상 시트)도 함께 통과 확인.

### 1.3 범위 제외 사항 (PM 지시에 따름)

- `packages/pii-mask/src/mask.ts`, `packages/pii-mask/src/profanity.ts`(M-3/M-4, 오탐 잔존) — 재리뷰에서 "Phase 3 이관, 이번 테스트 대상 아님"으로 명시되어 제외.
- N-1(override 감사 필드 위조), N-2(값 범위 위반 로깅 없음), N-3(stale dist) — "test-automation 범위 밖"으로 명시되어 제외.

## 2. 실행 결과 요약

```
$ pnpm --filter @auto-qa/api test
PASS src/eval-sheets/eval-sheet-invariants.spec.ts
PASS src/evaluation/evaluation.service.spec.ts

Test Suites: 2 passed, 2 total
Tests:       46 passed, 46 total
Snapshots:   0 total
Time:        ~3s
```

- 실행 명령: `pnpm --filter @auto-qa/api test` (내부적으로 `jest` 실행, `apps/api/jest.config.js` 기준)
- `pnpm --filter @auto-qa/web test`: `apps/web`에 `test` 스크립트가 없어 무동작(0건 실행, exit 0) — §0 참고.
- 테스트 총 46건, **46건 통과 / 0건 실패**.
  - 구조적 계약위반(502): 15건 통과
  - 값 범위 위반(manual_review): 13건 통과
  - 재시도 경로(성공/구조위반 즉시거부): 2건 통과
  - Mock 결정론성: 1건 통과
  - 평가시트 seed 로딩(도메인 수 + 10종 개별): 11건 통과
  - 평가시트 불변식 위반 거부(대조군 포함): 4건 통과
- 회귀 확인: 테스트 파일 추가 후 `pnpm --filter @auto-qa/api build`(prisma generate + tsc)도 정상 통과, `dist/`에 `*.spec.*` 산출물이 생성되지 않음을 확인(빌드 오염 없음).

## 3. 실패 원인 분석 (해당 없음)

이번 실행에서 실패한 테스트는 없다. 테스트 작성 중 아래 시행착오가 있었으나 모두 **테스트 코드 자체의 결함**이었고 프로덕션 코드 이슈는 아니었다:

- 최초 버전에서 `expect.assertions(2)`를 공용 헬퍼(`expectBadGateway`) 안에 두었는데, 호출부 중 하나가 추가로 단언을 덧붙이면서 "assertions 개수 불일치"로 1건 실패했다. 헬퍼를 `try/catch` 후 `caught` 변수 존재 여부로 판정하는 방식으로 수정해 해결했다(순수 테스트 코드 수정, `apps/api/src/evaluation/evaluation.service.spec.ts`만 변경).

## 4. 프로덕션 코드 결함 여부

이번 회귀 테스트 범위(`evaluation.service.ts`, `schema-builder.ts`, `schema.ts`) 내에서 **새로 발견된 결함은 없다**. 재리뷰(Round 2)에서 "해소(Verified)"로 판정된 H-1/H-2/M-1/M-2/M-6 관련 동작이 46건의 자동화된 회귀 테스트로 전부 재확인되었다. 재리뷰에서 이미 보고된 비차단 이슈(N-1/N-2, M-3/M-4)는 이번 범위에서 재현을 시도하지 않았으며(PM 지시), 기존 보고 내용 외 추가로 발견된 사항은 없다.

## 5. 커버리지가 부족한 영역 / 후속 권고

- **`apps/web` 테스트 전무**: 프론트엔드에 테스트 러너 자체가 구성되어 있지 않다(§0). 결과 화면의 게이팅 배지/코칭 요약/비속어 배지/Override UI(FR-8~FR-10) 등은 이번 태스크 범위 밖이라 다루지 않았으나, 별도 과제로 Vitest + React Testing Library 도입을 권고한다.
- **`packages/pii-mask`(마스킹/비속어) 단위 테스트 부재**: 재리뷰에서 M-3(비속어 오탐)/M-4(계좌번호 과탐) 잔존이 실측 보고되어 있음에도 이를 고정하는 회귀 테스트가 아직 없다. 이번 태스크는 PM 지시에 따라 범위에서 제외했으나, Phase 3 PII 고도화 착수 전 최소한 "현재 알려진 오탐/과탐 케이스"를 회귀 테스트로 먼저 고정해 두는 것을 권고한다(고도화 중 회귀 방지 목적).
- **N-1(override 감사 필드 위조) 회귀 테스트 부재**: `schema-builder.ts`의 item 스키마가 `.passthrough()`라 LLM 응답이 `originalScore`/`overridden` 등 감사 필드를 위조해도 현재는 통과한다. 이번 범위(§test-automation 인계 사항)에 명시되지 않아 테스트를 추가하지 않았으나, PM이 N-1 수정을 backend-implementer에게 지시할 경우 "LLM 응답에 override 필드가 실려도 무시/거부된다"는 회귀 테스트를 함께 추가해야 한다.
- **통합 테스트(HTTP 레벨) 부재**: 이번 라운드는 `EvaluationService`를 직접 인스턴스화하는 서비스 단위 테스트로 구성했다. `POST /transcripts` → `GET /transcripts/:id` 전체 HTTP 계약(컨트롤러/DTO 검증/PrismaService 연동 포함)을 다루는 e2e/통합 테스트는 아직 없다(`TranscriptsController`, `TranscriptsService`, Prisma 연동 등). PM 요청 범위가 evaluation.service.ts/schema-builder.ts/schema.ts로 한정되어 이번에는 다루지 않았으며, 별도 통합 테스트 스윗(`*.e2e-spec.ts` 등, 테스트 DB 필요) 추가를 후속 과제로 권고한다.
- **LLM-eval 회귀 테스트**: 실제 Anthropic/Gemini API 키가 아직 없으므로(`anthropic`/`gemini` 프로바이더는 스텁) `@llm-eval` 태그 테스트는 이번 Phase에서 작성하지 않았다. Phase 4/5에서 실제 키 확보 후 착수 권고.

## 6. 산출물 경로

- `D:\2. Team Source\Auto QA\apps\api\src\evaluation\evaluation.service.spec.ts` (신규)
- `D:\2. Team Source\Auto QA\apps\api\src\eval-sheets\eval-sheet-invariants.spec.ts` (신규)
- `D:\2. Team Source\Auto QA\apps\api\jest.config.js` (신규, 테스트 인프라)
- `D:\2. Team Source\Auto QA\apps\api\package.json` (devDependencies/`test` 스크립트 추가, 테스트 인프라)
- `D:\2. Team Source\Auto QA\apps\api\tsconfig.json` (`exclude` 추가, 빌드 산출물에서 스펙 파일 제외)
