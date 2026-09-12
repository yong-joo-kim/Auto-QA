# Phase 3 — PII 마스킹 강화: 테스트 리포트

- 대상 문서: `docs/requirements/phase3-pii-hardening.md`(§7 AC 전체, §10 DoD), `docs/review/phase3-pii-hardening-review.md`(1차), `docs/review/phase3-pii-hardening-review-round2.md`(2차), `docs/review/phase3-pii-hardening-review-round3.md`(3차, 최종 Pass)
- 대상 파일: `packages/pii-mask/src/{mask.ts,profanity.ts,mask-data.ts,profanity-data.ts}`(회귀 고정, 무변경), `apps/api/src/transcripts/transcripts.service.ts`(회귀 고정, 무변경), `apps/web/src/components/EvaluationMetaFooter.tsx`(회귀 고정, 무변경)
- 목적: 3라운드 코드리뷰에서 실측·논의된 케이스를 회귀 테스트로 고정하고, 반복적으로 "자동화 검증 부재(M-5)"로 지적된 FR-4(마스킹 관측성)를 신규로 테스트한다.
- 원칙: 이번 라운드는 **테스트 코드와 최소 테스트 인프라만 추가/수정**했다. 이미 3차 리뷰에서 Pass 판정을 받은 프로덕션 로직(`mask.ts`, `profanity.ts`, `transcripts.service.ts`, `EvaluationMetaFooter.tsx`)은 전혀 수정하지 않았다.

---

## 0. 사전 작업 — `apps/web` 테스트 인프라 신규 도입

`apps/web`은 Phase 1 테스트 리포트(§5) 시점부터 테스트 러너가 전혀 없었고, Phase 3 3차 리뷰(M-5)까지도 이 상태가 해소되지 않은 채로 남아 있었다. 이번 라운드에서 최소 구성으로 도입했다(E2E·커버리지 리포터 등 과도한 구성은 배제, `apps/api`의 jest 도입 방식과 동일한 취지):

- `apps/web/package.json`: devDependencies에 `vitest`(`^2.1.8`) 추가, `"test": "vitest run"` 스크립트 추가. React Testing Library는 도입하지 않았다 — 이번 범위(`formatMaskingSummary`)가 순수 함수이므로 컴포넌트 렌더링 테스트가 필요하지 않았다(PM 지시: 최소 구성, "순수 함수 단위 테스트가 가능한 최소 구성"으로 충분).
- `apps/web/vitest.config.ts` 신규 생성: `@vitejs/plugin-react` 플러그인 재사용(TSX 파일 import 시 JSX 변환), `test.include`를 `src/**/*.spec.ts(x)`로 한정, `environment: 'node'`(DOM 접근이 필요한 테스트가 생기면 이후 `jsdom`으로 승격 가능).
- `apps/web/tsconfig.json`: `exclude`에 `src/**/*.spec.ts`, `src/**/*.spec.tsx` 추가(`apps/api`/`packages/pii-mask`와 동일 컨벤션 — 스펙 파일이 타입체크/빌드 산출물에 섞이지 않게 함).
- `pnpm install --filter @auto-qa/web...`로 devDependency 설치(`pnpm-lock.yaml` 갱신).

이 변경은 애플리케이션 로직이 아닌 테스트 실행 인프라로만 판단해 추가했다(Phase 1 리포트 §0과 동일한 판단 기준).

---

## 1. 테스트 범위 및 목록

### 1.1 `packages/pii-mask/src/__fixtures__/mask-corpus.ts` (기존 파일 보강, PM 지시 항목 1·2)

기존 140케이스(3차 리뷰 시점)에 아래 항목을 추가했다. 로직 코드(`mask.ts`)는 건드리지 않고 데이터(코퍼스)만 보강했다.

- **AC-R-1 구분자 전수 조합 보강(최우선 인계 사항)**: 전화(휴대전화 `010`/유선전화 `02`)·카드(4-4-4-4/부분구분자) 4개 규칙 × SPACE·TAB·NBSP(U+00A0)·전각공백(U+3000)·U+2009 5종 구분자의 20개 조합을 전수 점검한 결과, 기존 코퍼스에 3개 조합이 비어 있었다(유선전화×SPACE, 유선전화×U+2009, 카드 4-4-4-4×U+2009). 3건을 추가해 20/20 조합을 전부 코퍼스에 고정했다.
- **카드 8개 레이아웃 커버리지 보강**: 3차 리뷰가 권고한 Phase 1 카드 레이아웃 공간(무구분/4-12/8-8/12-4/4-4-8/4-8-4/8-4-4/4-4-4-4) 8종을 전수 점검한 결과, **"8-8" 레이아웃 한 종류가 코퍼스에 전혀 없었다**(무구분은 Luhn 테스트로, 나머지 6종은 대표 구분자로 이미 커버되어 있었음). `카드 40128888-88888886 입니다` 케이스(하이픈, 대표 구분자)를 추가해 8/8 레이아웃을 전부 고정했다.
- **AC-M 보강 — 문맥 키워드 + 8자리(날짜 아님) 양성 케이스**: 2차 리뷰가 "계좌 12345678 로 입금 → [계좌번호]"를 실측 검증했다고 기록했으나 코퍼스에는 해당 케이스가 없어, M-3의 날짜 가드(`isLikelyYyyymmddDate`)가 향후 과도하게 넓어져 "날짜가 아닌" 정상 8자리 계좌번호까지 억제하게 되는 회귀를 잡지 못하는 사각지대가 있었다. `계좌 12345678 로 입금 확인 부탁드립니다` → `계좌 [계좌번호] 로 입금 확인 부탁드립니다` 케이스를 추가했다.
- CR/LF 구분자 미마스킹(개행 정책), 날짜 인접·소수 금액 나열·2자리 숫자 나열 등 나머지 AC-M 경계 케이스는 이미 3차 리뷰 시점 코퍼스에 반영되어 있어 추가하지 않았다(점검만 수행, 누락 없음 확인).

### 1.2 `packages/pii-mask/src/mask.spec.ts` (기존 파일 보강, PM 지시 항목 3)

- **AC-N-1 보강**: 기존 스펙은 `maskPii` 단독 100KB 처리 시간만 측정했다. `maskPii` + `detectProfanity` **합산**(순차 호출) 100KB 처리 시간이 500ms 미만인지 검증하는 테스트를 추가했다.
- **M-1 회귀 방지**: 1차 리뷰가 실측한 적대적 입력(`"12" + "-12".repeat(34000)`, ≈102KB, 수정 전 4,811ms)의 시간 상한을 1000ms로 고정하는 회귀 테스트를 추가했다(3차 리뷰 실측 기준 27~37ms에 충분한 여유를 둠 — 향후 이메일 정규식/규칙 순서가 바뀌어 다항 백트래킹이 재발하면 즉시 실패).

### 1.3 `packages/pii-mask/src/profanity.spec.ts` (기존 파일 보강, PM 지시 항목 3)

- **AC-N-2 보강**: `detectProfanity`의 1MB 단일 라인(한글) 입력에서 예외가 발생하지 않는지 확인하는 테스트를 추가했다(기존에는 `maskPii`만 1MB 경계 테스트가 있었음).
- **AC-N-2 보강**: 어절 토크나이저(`TOKEN_DELIMITER_PATTERN`, 공백·문장부호·기호 기준 분할)의 최악 입력인 문장부호/기호 밀집 1MB 입력에서 예외 없이, 1000ms 이내에 처리되는지 확인하는 테스트를 추가했다(NFR-3.1 ReDoS 관점 겸용).

### 1.4 `apps/api/src/transcripts/transcripts.service.spec.ts` (신규, PM 지시 항목 4)

`TranscriptsService`를 NestJS DI 컨테이너 없이 직접 인스턴스화하고(Phase 1 `evaluation.service.spec.ts`와 동일 방식), `PrismaService`는 인메모리 Map 기반 fake로, `EvalSheetsService`/`EvaluationService`는 고정 반환값의 fake로 대체했다.

- **FR-4 maskingSummary 저장→조회 왕복**: PII(전화번호 1건)가 포함된 rawText로 `createAndEvaluate` → `getResult` 왕복 시 `maskingSummary`가 `{ rrn: 0, phone: 1, card: 0, account: 0, email: 0 }`로 정확히 반영되는지 확인. PII가 없는 rawText는 5종 모두 0으로 반환되는지 확인. `getResultByEvaluationId` 대안 경로로 조회해도 동일한 값이 내려오는지 확인.
- **Phase 1 AC-6 유지 확인**: 저장된 `maskedText`(fake prisma 내부 저장값)에 원문 전화번호 패턴이 남아있지 않고 `[전화번호]` placeholder만 존재하는지 확인.
- **L-4 `parseMaskingSummary` 방어(500 미발생)**: `maskingSummary` 컬럼이 `null`(레거시 레코드)이면 응답도 `null`인지 확인. 컬럼 값이 손상된 JSON(`'{invalid-json'`, 수동 DB 조작 상황을 흉내)이어도 `getResult`가 예외를 던지지 않고 `maskingSummary: null`로 방어되며 나머지 응답 필드는 정상적으로 채워지는지 확인.

### 1.5 `apps/web/src/components/EvaluationMetaFooter.spec.ts` (신규, PM 지시 항목 4)

`formatMaskingSummary`(export된 순수 함수)에 대해 지시된 최소 4분기를 검증한다. `isValidMaskingSummary`는 export되지 않으므로 `formatMaskingSummary`의 출력(스펙 위반 입력 시 "정보 없음" 분기로 빠지는지)을 통해 간접 검증했다.

- 1분기(정상, 1건 이상 탐지): `{rrn:0, phone:2, card:0, account:0, email:1}` → `PII 마스킹: 전화번호 2건, 이메일 1건`. 추가로 입력 객체의 키 선언 순서를 뒤섞어도(`{email, account, card, phone, rrn}`) 출력 순서가 `rrn>phone>card>account>email` 고정 순서를 따르는지 확인(UI 스펙 §2.1).
- 2분기(전부 0건): `PII 마스킹: 해당 없음`.
- 3분기(`null`/`undefined`, 레거시 레코드): `PII 마스킹: 정보 없음 (이 평가는 집계 이전에 처리되었습니다)`.
- 4분기(스펙 위반 — `isValidMaskingSummary` 방어 경로): 빈 객체 `{}`, 일부 키 누락(`{rrn:0, phone:1}`), 비숫자 값 포함(`{..., phone: '1', ...}`) 3종 모두 "정보 없음"으로 방어 처리되는지 확인(UI 스펙 §5.3 — "해당 없음"과 혼동되지 않아야 함).

### 1.6 범위 제외 사항

- 비속어 `KNOWN_FALSE_NEGATIVE_CASES` 회귀 연결 여부 점검(인계 사항 5): `profanity.spec.ts`에 이미 `describe('detectProfanity — M-4 알려진 미탐 한계(정책상 false로 고정, 회귀 감시용)')`로 연결되어 실행 중임을 코드로 확인했다(추가 조치 불필요).
- `mask.ts`/`profanity.ts`/`transcripts.service.ts`/`EvaluationMetaFooter.tsx` 자체의 로직 변경: 3차 리뷰가 이미 Pass 판정했으므로 이번 범위에서 수정하지 않았다. 아래 §4에서 테스트 작성 중 발견한 프로덕션 코드 관련 관찰 사항(결함은 아님)을 별도로 기록한다.

---

## 2. 실행 결과 요약

```
$ pnpm --filter @auto-qa/pii-mask test
PASS src/mask.spec.ts
PASS src/profanity.spec.ts

Test Suites: 2 passed, 2 total
Tests:       149 passed, 149 total   (3차 리뷰 시점 140 → +9)
```

```
$ pnpm --filter @auto-qa/api test
PASS src/eval-sheets/eval-sheet-invariants.spec.ts
PASS src/evaluation/evaluation.service.spec.ts
PASS src/transcripts/transcripts.service.spec.ts

Test Suites: 3 passed, 3 total
Tests:       52 passed, 52 total     (Phase 1 시점 46 → +6, 신규 스윗 1개)
```

```
$ pnpm --filter @auto-qa/web test
✓ src/components/EvaluationMetaFooter.spec.ts (8 tests)

Test Files: 1 passed (1)
Tests:      8 passed (8)             (apps/web 최초 테스트 스윗)
```

- **전체 209개 테스트(149 + 52 + 8), 209건 통과 / 0건 실패.**
- 회귀 확인: `packages/pii-mask` 기존 140개, `apps/api` 기존 46개가 이번에 추가한 케이스와 함께 전부 그대로 통과했다(신규 케이스 추가로 인한 회귀 없음).
- 빌드 오염 확인:
  - `pnpm --filter @auto-qa/pii-mask build` 통과, `dist/`에 `*.spec.*`/`__fixtures__/` 없음(AC-N-4 유지).
  - `pnpm --filter @auto-qa/web exec tsc --noEmit` 0 error.
  - `pnpm --filter @auto-qa/web build`(`tsc --noEmit` + `vite build`) 정상 통과, 산출물에 스펙 파일 미포함(56 modules transformed, 스펙 파일은 어디서도 import되지 않아 번들에서 자동 제외됨).
  - `pnpm --filter @auto-qa/api exec tsc -p tsconfig.json --noEmit` 0 error.
- `pnpm lint`: 0 error / 11 warning — 전부 기존에 보고된 경고(`evaluation.service.spec.ts`의 `no-explicit-any` 10건, `main.ts`의 미사용 eslint-disable 1건)이며, 이번에 추가한 파일(`transcripts.service.spec.ts`, `EvaluationMetaFooter.spec.ts`, `mask-corpus.ts` 보강분)에서 새로 발생한 경고/에러는 없다.

---

## 3. 실패 원인 분석

이번 실행에서 실패한 테스트는 없다. 코퍼스/스펙 작성 중 아래 설계 의도를 재확인하며 케이스를 교정한 사항이 있었으나, 전부 **테스트 케이스 설계 단계**에서 정정한 것이고 프로덕션 코드 결함은 아니었다:

- AC-M 보강 케이스(`계좌 12345678 로 입금 확인 부탁드립니다`) 작성 시, 계좌 문맥 키워드는 후보 숫자열 **앞** 15자 이내에 있어야 인식됨(`hasAccountContext`가 `matchStartIndex` 이전 구간만 검사)을 재확인하고, 키워드가 숫자열보다 뒤에 오는 문장 구조를 피해 케이스를 작성했다.
- 8-8 카드 레이아웃 보강 케이스 작성 시, `CARD_PARTIAL_SEP_PATTERN`의 그룹 길이 제약(각 그룹 2~12자리, 3차 리뷰에서 8→12로 완화됨)을 확인하고 8자리+8자리 조합이 이 제약을 만족함을 사전에 계산해 케이스를 구성했다(불필요한 시행착오 없이 1회에 통과).

---

## 4. 프로덕션 코드 관련 관찰 사항 (결함 아님, PM 참고용)

이번 범위에서 **새로 발견된 프로덕션 코드 결함은 없다.** 3차 리뷰(Pass 판정)의 판단과 실측이 이번 보강 테스트로 재확인되었다. 다만 테스트 작성 과정에서 확인한 구조적 사실 2가지를 참고로 남긴다(수정 불필요, 정보 제공 목적):

1. `apps/web/src/components/EvaluationMetaFooter.tsx`의 `isValidMaskingSummary` 함수는 모듈 내부에만 존재하고 export되지 않는다. 이번 4분기 테스트는 `formatMaskingSummary`의 출력(정보 없음 분기로 빠지는지)을 통해 간접 검증했다 — 직접 단위 테스트가 필요하다면 export가 필요하나, 현재 동작에는 문제가 없으므로 프로덕션 코드 변경을 요청하지 않았다.
2. `packages/pii-mask/src/mask.ts`의 `applyCardPartialSeparatorRule`(H-1/H-1(R2)/H-1(R3) 계열 규칙)은 그룹 길이 상한이 3차 리뷰에서 8 → 12로 완화된 이후, "8-8" 레이아웃(그룹 길이 8, 8)이 정상적으로 포함되는지가 코퍼스에서 검증되지 않고 있었다. 이번에 추가한 케이스로 확인 결과 **정상 동작함**(회귀 없음)을 확인했으며, 로직 자체는 건드리지 않았다.

---

## 5. 커버리지가 부족한 영역 / 후속 권고

- **`apps/web` 컴포넌트 렌더링 테스트 부재**: 이번에 도입한 Vitest 구성은 순수 함수(`formatMaskingSummary`) 테스트만 다루며, `EvaluationMetaFooter` 컴포넌트 자체의 렌더링(JSX 출력, `success`/`loading`/`error` 상태별 분기 등)이나 `ProfanityBadge` 등 다른 컴포넌트는 테스트하지 않았다. React Testing Library 도입은 PM 지시(최소 구성 원칙)에 따라 이번 라운드에서 보류했다 — 후속 Phase에서 컴포넌트 테스트가 필요해지면 `@testing-library/react` + `jsdom` 환경 추가를 권고한다.
- **`apps/api` HTTP 레벨 통합 테스트 부재**: 이번 `transcripts.service.spec.ts`는 서비스 단위 테스트(fake Prisma)이며, `POST /transcripts` → `GET /transcripts/:id` 전체 HTTP 계약(컨트롤러/DTO 검증/실제 PrismaService 연동)을 다루는 e2e 테스트는 여전히 없다(Phase 1 리포트 §5에서도 동일하게 지적됨, 아직 미해결). 별도 통합 테스트 스윗(`*.e2e-spec.ts`, 테스트 DB 필요) 추가를 후속 과제로 재권고한다.
- **비속어 자모 분리·특수문자 삽입 변형 탐지 부재**: 요구사항 §5.3/§9에서 이미 Out of scope로 명시된 한계(`ㅅㅂ`, `시1발`, `시*발` 등)이며, 이번 테스트 범위에도 포함하지 않았다(정책상 의도된 미탐).
- **`overrideItemScore`(FR-10) 경로에 대한 fake-prisma 기반 단위 테스트 부재**: 이번 라운드는 PM 지시 범위(FR-4 maskingSummary 왕복 + 방어)에 한정했으므로 `TranscriptsService.overrideItemScore`는 다루지 않았다. 별도 과제로 남긴다.
- **LLM-eval 회귀 테스트(`@llm-eval` 태그)**: 실제 Anthropic/Gemini API 키가 아직 없어(Phase 1 리포트 §5와 동일) 이번에도 작성하지 않았다.

---

## 6. 산출물 경로

- `D:\2. Team Source\Auto QA\packages\pii-mask\src\__fixtures__\mask-corpus.ts` (보강 — 구분자 전수 조합 3건, 8-8 레이아웃 1건, AC-M 양성 케이스 1건 추가)
- `D:\2. Team Source\Auto QA\packages\pii-mask\src\mask.spec.ts` (보강 — 합산 성능 테스트, M-1 적대적 입력 시간 상한 회귀 테스트 추가)
- `D:\2. Team Source\Auto QA\packages\pii-mask\src\profanity.spec.ts` (보강 — 1MB 단일 라인/문장부호 밀집 경계 테스트 추가)
- `D:\2. Team Source\Auto QA\apps\api\src\transcripts\transcripts.service.spec.ts` (신규)
- `D:\2. Team Source\Auto QA\apps\web\src\components\EvaluationMetaFooter.spec.ts` (신규)
- `D:\2. Team Source\Auto QA\apps\web\vitest.config.ts` (신규, 테스트 인프라)
- `D:\2. Team Source\Auto QA\apps\web\package.json` (devDependencies에 `vitest` 추가, `test` 스크립트 추가, 테스트 인프라)
- `D:\2. Team Source\Auto QA\apps\web\tsconfig.json` (`exclude`에 스펙 파일 추가, 테스트 인프라)
