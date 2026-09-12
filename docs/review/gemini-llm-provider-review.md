# Gemini LLM Provider 실연동 코드 리뷰

**판정: 수정 필요 (Fail) — H-1(비밀키가 서버 로그로 흘러갈 수 있는 구조적 경로, AC-7 위반 가능) / H-2(재시도 지연 상한 없음)가 차단. 그 외 PII 전송 경로·배점 무결성·fail-fast·에러 매핑은 전부 통과**

## 1. 검토 범위

- 대상(working tree, 미커밋): `apps/api/src/evaluation/llm/gemini-llm-evaluation.provider.ts`, `gemini-schema-builder.ts`, `gemini-prompt.ts`, `http-retry.ts`, `env-utils.ts`, `apps/api/src/evaluation/evaluation.module.ts`, 신규 테스트 3종(`http-retry.spec.ts`, `gemini-llm-evaluation.provider.spec.ts`, `evaluation.module.spec.ts`), `llm/README.md`, `.env.example`, `CLAUDE.md`, `docs/decisions/ADR-001-gemini-llm-provider.md`
- 기준 문서: `docs/requirements/gemini-llm-provider.md`(FR-1~FR-12 / AC-1~AC-13 / D-1~D-7, PM 전제 정정 2건 포함), ADR-001, `CLAUDE.md` §컨벤션
- 회귀 기준선: `apps/api/src/evaluation/evaluation.service.ts`, `llm/schema-builder.ts`, `packages/pii-mask`(Phase 1·3 계약) — 이번 변경으로 수정되지 않았음을 `git status`로 확인
- 검증 방법: 정적 추적(로그/에러 출력 지점 전수 grep) + 테스트·타입체크·빌드 실행 + Node 런타임 실측(헤더 값 오류 시 에러 메시지에 키가 포함되는지 직접 재현)

## 2. 실행 결과

| 명령 | 결과 |
| ---- | ---- |
| `pnpm --filter @auto-qa/api test` | 통과 (6 suites / 74 tests, 실 Gemini API 호출 0건 — 전부 로컬 스텁 서버) |
| `pnpm --filter @auto-qa/pii-mask test` | 통과 (2 suites / 149 tests, Phase 3 골든 코퍼스 회귀 없음) |
| `pnpm --filter @auto-qa/api exec tsc --noEmit` | 0 error (exit 0) |
| `pnpm --filter @auto-qa/api build` | 통과 (prisma generate + tsc, exit 0) |
| `pnpm --filter @auto-qa/api lint` | 실행 불가 — `@auto-qa/api`에 `lint` 스크립트가 없음(ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT) |
| 리포지토리 키 스캔(`git grep AIza`, 워킹트리 grep) | 커밋·추적 파일·문서·`.env.example` 전부 0건. `.env`(gitignore 대상)에만 존재 |

## 3. 지시받은 중점 항목별 판정

| 검증 항목 | 판정 | 실측 근거 |
| --------- | ---- | -------- |
| 1. 키 전송 방식(URL vs 헤더) | 통과 | `provider.ts:101` `x-goog-api-key` 헤더. URL(`:89`)은 `{base}/v1beta/models/{model}:generateContent`로 키 미포함. 스텁 테스트가 요청 본문에도 키 부재를 확인 |
| 1. 로그/에러 경로의 키 노출 | **미통과** | H-1 참조 — 헤더 값 오류 시 Node `fetch`의 TypeError 메시지에 키 전문이 포함되고 그대로 2중 로깅됨 |
| 2. 구조적 키 노출 경로(사고 연계) | 통과 | 코드가 `.env`를 직접 읽거나 덤프하는 경로 없음(`process.env` 직접 접근은 `main.ts`/mock 프로바이더뿐, Gemini 경로는 ConfigService 경유). FR-10.3 디버그 덤프 기능 미구현. `cat .env` 사고는 세션 로그 한정이며 코드·커밋에는 잔존물 없음 |
| 3. 에러 매핑 경계(500 vs 502) | 통과 | 프로바이더는 상태코드를 결정하지 않고 전부 throw(`:146-155`) → `EvaluationService.invokeProvider`가 500. 구조 위반 응답은 보정 없이 통과시켜 zod가 502 처리. 스텁 테스트 7건이 각 경로 고정 |
| 4. 스키마 방언 우회의 원칙 유지 | 통과 | `gemini-schema-builder.ts:38` 항목별 `maximum: item.maxScore`, `:54` `required: itemIds`로 누락 차단. `const`/`additionalProperties` 미사용은 서버 zod `.strict()`가 보완 (단 L-2) |
| 5. 재시도 중복/충돌·무한루프 | 통과 | 계층 분리(서비스=값 범위 위반 1회, 프로바이더=전송 오류). `http-retry.ts:59-97` 루프 상한 `maxRetries+1`, 마지막 시도에서는 sleep 없이 throw. 무한루프 없음 (단 H-2/M-3 지연 상한) |
| 6. profanityCheck 로컬 산출(D-7) | 통과 | `provider.ts:129` `detectProfanity(request.maskedTranscript)`, Gemini 응답 스키마에서 `profanityCheck` 제외(`gemini-schema-builder.ts:23`). mock과 동일 경로라 LLM 판정과 혼동 없음 |
| 7. fail-fast(AC-6) | 통과 | `evaluation.module.ts:40-55` 팩토리에서 키/모델 누락 시 throw, 메시지에 값 미포함. `evaluation.module.spec.ts` 3건(키 없음/모델 없음/mock 기본값) 실측 통과 |
| 8. PII 전송 경로 | 통과 | 프롬프트에 들어가는 텍스트는 `request.maskedTranscript`뿐(`gemini-prompt.ts:75`). 원문(`rawText`)은 인터페이스상 도달 불가. 요청 본문 캡처 테스트가 placeholder 존재를 고정 |
| 9. 결정론성 비적용 명시(AC-9) | 부분 통과 | 테스트는 전부 스텁 기반이라 결정론을 잘못 가정하지 않음. 다만 "gemini에는 AC-8이 적용되지 않는다"가 코드/`llm/README.md`/ADR에 한 줄도 없음 (L-3) |
| 10. 기존 계약 회귀 | 통과 | api 74 tests / pii-mask 149 tests 전부 통과, `evaluation.service.ts`·`schema-builder.ts`·`packages/pii-mask` 무변경, mock 기본값 유지 |

## 4. 발견 사항

### H-1 (High, 차단) 잘못된 형식의 `GEMINI_API_KEY`가 에러 메시지를 통해 서버 로그에 평문으로 기록된다

- 위치: `apps/api/src/evaluation/llm/gemini-llm-evaluation.provider.ts:101`(헤더 주입) → `:224-229` `toSafeErrorMessage` → `:151-153`(프로바이더 로그) → `apps/api/src/evaluation/evaluation.service.ts:127-130`(서비스 재로깅)
- 원인: 키 값이 HTTP 헤더로 허용되지 않는 ASCII 문자(CR/LF/NUL 등)를 포함하면 Node의 `fetch`가 **키 전문을 담은** TypeError를 던진다. `toSafeErrorMessage`는 `HttpStatusError`/`HttpTimeoutError`가 아닌 일반 `Error`에 대해 `error.message`를 **그대로 반환**하므로 마스킹이 전혀 일어나지 않는다. 또한 프로바이더는 원본 error를 rethrow하므로 `EvaluationService`가 동일 메시지를 한 번 더 로그에 남긴다(총 2회).
- 실측(Node v24.19.0, 이 저장소에서 직접 재현):

| 키 형태 | `fetch` 에러 메시지 | 키 노출 |
| ------- | -------------------- | ------- |
| 중간 개행 `AIzaSy\nFAKE123` | `Headers.append: "AIzaSy\nFAKE123" is an invalid header value.` | **전문 노출** |
| 후행 개행 `AIzaSyFAKE123\n` | (정규화되어 헤더 오류 없음) | 없음 |
| U+200B / 한글 포함 | `... character at index 10 has a value of 8203 ...` | 없음(인덱스만) |

- 영향: AC-7("서버 로그 전량에서 키 및 그 부분 문자열이 단 한 건도 발견되지 않는다") / NFR-1.2 위반. 개행이 섞여 인증에 실패하는 키라도, 로그에서 개행만 제거하면 원 키가 그대로 복원된다. 트리거 조건은 "줄바꿈된 터미널/웹 화면에서 키를 복사해 `.env`에 붙여넣는" 현실적인 시나리오다.
- 부가(구현/주석 불일치): `:219-223` 주석은 "에러 메시지에서 API 키가 포함될 가능성이 있는 부분을 방어적으로 마스킹한다"고 서술하지만 함수에 마스킹 로직이 없다. 주석이 리뷰어·후속 구현자(Anthropic)를 오도한다.
- 권고(택일 아님, 3개 모두 권장):
  1. `evaluation.module.ts`의 gemini 분기와 `provider.evaluate()` 진입부에서 키 형식을 검증한다(예: `/^[\x21-\x7e]+$/` 불일치 시 "GEMINI_API_KEY 형식이 올바르지 않습니다(허용되지 않는 문자 포함)" — **값은 출력하지 않음**). 기동 시점에 걸러지므로 AC-6와도 일관된다.
  2. `toSafeErrorMessage(error, apiKey)`로 시그니처를 바꿔 `message.split(apiKey).join('[REDACTED]')` 및 `Headers.append` 계열 TypeError 메시지 폐기를 실제로 수행한다.
  3. 프로바이더가 상위로 던지는 에러를 정제된 메시지의 새 `Error`로 감싼다(현재 원본 rethrow 때문에 `EvaluationService`가 2차 노출 지점이 된다).

### H-2 (High, 차단) `Retry-After`를 상한 없이 그대로 수용 — 단일 채점 요청이 무제한 지연될 수 있다

- 위치: `apps/api/src/evaluation/llm/http-retry.ts:104-117`(`defaultBackoffMs`), 호출부 `:74`
- 내용: `Retry-After: 3600` → `3600 * 1000`ms(1시간) 그대로 sleep한다. HTTP-date 형식도 `delta`를 무제한 수용한다. `Math.min(..., 8000)` 캡은 **Retry-After가 없는 경로에만** 적용된다.
- 영향: 429 지속 시 프로바이더 1회 호출이 `maxRetries × Retry-After`만큼 블로킹되고, `EvaluationService`가 값 범위 위반으로 1회 더 호출하면 그 2배가 된다. 프런트(`apps/web/src/api/client.ts:42`)에 클라이언트 타임아웃이 없어 사용자는 화면에서 무한 대기한다. NFR-4.1(P50 30초)·FR-7.7(상한 계산)·AC-5("행 걸림 없음")의 취지와 정면 충돌하며, Gemini 무료 티어 429 대응(§3.6)에서 실제로 발생할 수 있는 경로다.
- 권고: `return Math.min(retryAfterMs, RETRY_AFTER_CAP_MS)`(예: 10~30초)로 캡을 걸고, 캡을 초과하는 힌트를 받으면 재시도를 포기하고 즉시 throw(→ 500, 사용자에게 재시도 버튼)하는 편이 UX·NFR 모두에 유리하다.

### M-1 (Medium) 타임아웃이 응답 헤더 수신까지만 적용되고 본문 수신 구간은 보호되지 않는다

- 위치: `http-retry.ts:64-67`(`clearTimeout(timer)` 후 response 반환) → `gemini-llm-evaluation.provider.ts:113`(`await response.json()`)
- 내용: `AbortController` 타이머가 본문 파싱 전에 해제되므로, 서버가 헤더만 보내고 본문을 흘리지 않으면 `GEMINI_TIMEOUT_MS`가 아니라 undici 기본 bodyTimeout(약 300초)까지 대기한다. FR-7.1("타임아웃 없는 호출은 허용하지 않는다")·AC-5의 "행 걸림 없음"을 완전히 만족하지 못한다. 현재 스텁 테스트는 **헤더 이전 무응답**만 재현하므로 이 경로를 잡지 못한다.
- 권고: 본문 소비가 끝난 뒤에 `clearTimeout`하도록 수명을 연장하거나, `fetchWithRetry`가 `json()`까지 수행해 반환하는 형태로 책임을 옮긴다. 재시도 루프의 컨트롤러 수명 관리에 유의할 것.

### M-2 (Medium) 실패 경로의 `attempts` 로그가 항상 1 — 재시도 횟수 진단이 불가능하다

- 위치: `gemini-llm-evaluation.provider.ts:91`(`let attempts = 0`), `:111`(성공 시에만 대입), `:152`(`attempts || 1`)
- 실측: `pnpm --filter @auto-qa/api test` 실행 로그에서 `GEMINI_MAX_RETRIES=1`(실제 2회 호출)인 429/503 케이스가 전부 `attempts=1`로 기록됨 — `Gemini 호출 실패 (domainId=test-domain, model=gemini-test-model, attempts=1, latencyMs=628): HttpStatusError: status=429`
- 영향: FR-10.1(시도 횟수)·AC-12·요구사항 §3.6("로그에 429와 재시도 횟수가 남아 원인 파악 가능") 미충족. ADR-001이 경고한 `gemini-3.8-flash`의 503 빈도를 운영에서 계측할 수 없다(모델 전환 판단 근거가 사라진다).
- 권고: `HttpStatusError`/`HttpTimeoutError`에 `attempts` 필드를 싣거나, `fetchWithRetry`가 던지는 에러에 시도 횟수를 첨부해 프로바이더가 실제 값을 로그에 남기도록 한다.

### M-3 (Medium) FR-7.7의 최악 소요 시간 상한이 계산·문서화되지 않았다

- 기본값(timeout 60s / retries 2) 기준 산출: 프로바이더 1회 = 3시도 × 60초 + 백오프(≈0.5s + 1.0s + 지터) ≈ **182초**, `EvaluationService`의 값 범위 위반 재호출 포함 ≈ **364초(약 6분)**. H-2가 겹치면 상한 자체가 사라진다.
- ADR-001 / `llm/README.md` / `.env.example` / 요구사항 §7 어디에도 이 수치가 없다(문서 전수 grep 확인). FR-7.7은 "상한을 계산해 문서화하고, 과도하면 기본값을 조정한다"를 명시적으로 요구한다.
- 권고: ADR-001 또는 `llm/README.md`에 상한 표를 추가하고, 6분이 과도하다고 판단되면 기본값을 (timeout 60s, retries 1) 또는 (timeout 30s, retries 2)로 조정한다. FE 로딩 안내 문구(FR-12.1)와의 정합도 함께 검토할 것.

### M-4 (Medium) thinking 기본 활성 + `GEMINI_MAX_OUTPUT_TOKENS=8192` 조합의 절단(500) 위험이 검증되지 않았다

- 위치: `.env.example:29-30`(`GEMINI_THINKING_BUDGET=` 빈 값 = 모델 기본 = thinking 활성), `gemini-llm-evaluation.provider.ts:63-67, 85`
- 내용: ADR-001 D-2 표가 "기본은 thinking 활성(`thinkingBudget: 0`으로 꺼야 `thoughtsTokenCount`가 사라짐)"을 실측으로 기록했다. 사고 토큰이 출력 예산을 잠식하는 모델에서 항목 14개 × 한국어 사유 + 코칭을 8192 토큰에 담지 못하면 `finishReason=MAX_TOKENS` → 재시도 없이 500(FR-7.4 의도대로)이며, 사용자에게는 원인 불명 실패로 보인다.
- 권고: telecom 실시트로 1회 실호출해 `tokens.out`/thoughts 사용량을 계측한 뒤 (a) 기본 `GEMINI_MAX_OUTPUT_TOKENS` 상향 또는 (b) `.env.example` 기본값을 `GEMINI_THINKING_BUDGET=0`으로 권고 표기 중 하나를 택하고 ADR에 관측값을 남긴다. AC-1 수동 검증 시 함께 확인 가능한 항목이다.

### L-1 (Low) 숫자형 env의 비정상 값 방어가 없다

- `env-utils.ts:7-20`은 `Number.parseInt('10abc')`를 경고 없이 10으로 받아들이고, 음수/0을 그대로 통과시킨다. `GEMINI_MAX_RETRIES=-1`이면 `http-retry.ts:56`의 `totalAttempts = 0`이 되어 **루프가 한 번도 실행되지 않고** `:101`의 "HTTP 요청이 반복 실패했습니다."라는 오도된 메시지로 500이 된다(API 호출 0회).
- 권고: `maxRetries`는 0~5, `timeoutMs`는 1000~120000 등으로 clamp하고, 클램프 시 경고 로그를 남긴다.

### L-2 (Low) itemId 중복 시 G-2 객체 스키마가 조용히 붕괴한다 (배점 무결성 관점)

- `gemini-schema-builder.ts:31`은 `itemProperties[item.itemId]`에 대입하므로 동일 itemId가 두 카테고리에 있으면 뒤 항목이 앞 항목을 덮어쓴다 → 남는 `maximum`이 더 클 수 있고, 응답도 1건만 오며, `aggregateFromScoredItems`가 같은 결과를 두 항목에 중복 반영한다.
- `packages/eval-schema/src/schema.ts:77`의 `listItemIds`는 주석에 "중복 없이"라고 적혀 있으나 실제로는 `flatMap`이라 dedupe하지 않으며, itemId 유일성 검증도 zod 스키마·`eval-sheet-invariants.spec.ts` 어디에도 없다(선행 결함). 배열 기반 스키마에서는 `minItems/maxItems`로 드러나던 문제가 G-2 채택으로 더 조용해졌다.
- 권고: `evalSheetSchema`의 `superRefine`에 itemId 유일성 검증을 추가하거나, 최소한 `eval-sheet-invariants.spec.ts`에 seed 10종 대상 불변식을 추가한다. 실제 평가시트 반입(Phase 4) 전에 처리할 것을 권고.

### L-3 (Low) AC-9(결정론성 비적용)가 코드·README·ADR에 명시되지 않았다

- 요구사항 NFR-5에만 존재하고 `llm/README.md`·ADR-001·프로바이더 주석에는 한 줄도 없다. 테스트는 전부 스텁 기반이라 결정론을 잘못 가정하고 있지는 않다(AC-10의 "기본 `pnpm test`가 실 API를 호출하지 않는다"도 충족).
- 권고: `llm/README.md`에 "실 프로바이더는 Phase 1 AC-8 / Phase 3 AC-R-3(2회 제출 동일성)의 적용 대상이 아니며, 결정론 회귀는 mock/스텁으로만 수행한다" 1~2줄 추가.

### L-4 (Low) 재시도 시 실패 응답 본문을 소비하지 않는다

- `http-retry.ts:69-76`에서 429/5xx 응답의 body를 읽지도 취소하지도 않고 `continue`한다. undici 커넥션 재사용이 지연될 수 있다. `await response.body?.cancel()` 한 줄 권고(응답 본문을 로그에 남기지 않는 현 정책과도 충돌하지 않음).

### L-5 (Low) `GEMINI_API_BASE_URL` 정규화·검증 없음

- `provider.ts:53, 89`에서 trim만 하고 그대로 연결하므로 후행 슬래시가 있으면 `//v1beta/...`가 된다. 또한 임의 호스트를 넣으면 `x-goog-api-key` 헤더가 그 호스트로 전송된다(env 신뢰 전제이므로 심각도는 낮고, `.env.example:27`에 "테스트 전용" 주석은 존재).
- 권고: 후행 슬래시 제거 + 기본 URL이 아닐 때 기동 로그에 1줄 경고("GEMINI_API_BASE_URL 오버라이드 사용 중 — 운영 금지").

### L-6 (Low) 타입 안전성 — 이중 캐스팅과 `unknown` 통과 범위

- `provider.ts:142`(`coaching: parsedObj.coaching`), `:145`(`as unknown as LlmEvaluationResponse`). FR-5의 passthrough 설계상 불가피하지만, `RawGeminiPayload` 같은 전용 타입을 두고 캐스팅 지점을 한 곳으로 좁히면 의도가 명확해진다.
- 부가 경계: 응답이 JSON이지만 객체가 아닌 경우(배열/문자열) `parsedObj = {}`가 되어 500이 아니라 **502**로 분류된다. FR-7.6 표의 "JSON 파싱 실패 → 500"과 경계가 모호하므로, 동작을 유지하더라도 README/ADR에 "유효 JSON이지만 객체가 아니면 구조 위반(502)으로 취급"을 한 줄 명시할 것.

### L-7 (Low) `finishReason` 누락 응답을 일괄 실패 처리

- `provider.ts:206-209`에서 `finishReason`이 없으면 `'UNKNOWN'` → 즉시 throw(500). Gemini는 통상 `STOP`을 반환하므로 현재 위험은 낮으나, 방언 변화 시 정상 응답이 500이 된다. `STOP`/누락을 허용하고 명시적 비정상 사유(`MAX_TOKENS`/`SAFETY`/`RECITATION` 등)만 거부하는 화이트리스트 방식이 더 견고하다.

## 5. 종합 의견

- **PII 처리(NFR-1.1/AC-8)와 배점 무결성(FR-3/AC-2)은 설계대로 지켜졌다.** Gemini로 나가는 텍스트는 `maskedTranscript`뿐이고, 프로바이더는 점수를 clamp·보정하지 않으며(스텁 테스트 4건이 passthrough를 고정), 배점 상한은 `maximum`으로 API 레벨에서, 항목 완전성은 `required`로 강제된 뒤 서버 zod + `aggregateFromScoredItems` 재계산이 최종 방어선을 유지한다. D-2 우회가 원칙을 새게 하지 않았다.
- **구현 중 발생한 `cat .env` 키 노출 사고는 "코드의 구조적 결함"이 아니다.** 프로바이더·모듈·테스트 어디에도 env 파일을 통째로 읽거나 덤프하는 코드가 없고, 리포지토리 전체 스캔에서도 키는 `.env`(gitignore 대상)에만 존재한다. 다만 **별개로** 코드에 키가 로그로 흘러갈 수 있는 경로가 하나 남아 있다(H-1) — 이 둘은 분리해 판정한다.
- 차단 사유는 H-1(보안, AC-7)과 H-2(NFR, 무제한 지연)다. 둘 다 수정 범위가 작고(`toSafeErrorMessage` + 키 형식 검증, `defaultBackoffMs` 캡) 기존 계약을 건드리지 않으므로, 재작업 후 재리뷰는 경량으로 가능하다.
- 참고: `@auto-qa/api`에 `lint` 스크립트가 없어 린트 확인을 수행하지 못했다(루트 `eslint.config.js`는 존재). 별도 이슈로 추적을 권고한다.

## 6. 재작업 요청 (backend-implementer)

| ID | 심각도 | 요청 내용 | 완료 판정 방법 |
| -- | ------ | --------- | -------------- |
| H-1 | High | 키 형식 검증(기동+호출 진입) 추가, `toSafeErrorMessage`가 실제로 키를 치환, 상위로 던지는 에러도 정제 | 중간 개행 포함 키로 evaluate 호출 시 로그·에러에 키 미출현 테스트 |
| H-2 | High | `Retry-After` 수용값에 상한(예: 10~30초) 적용, 초과 시 즉시 실패 | `Retry-After: 3600` 스텁 응답으로 지연 상한 검증 테스트 |
| M-1 | Medium | 응답 본문 수신 구간까지 타임아웃 적용 | 헤더만 보내고 본문을 멈추는 스텁으로 `GEMINI_TIMEOUT_MS` 내 중단 확인 |
| M-2 | Medium | 실패 경로에도 실제 시도 횟수를 로그에 기록 | 429 반복 스텁(`MAX_RETRIES=2`) 실패 로그에 `attempts=3` 확인 |
| M-3 | Medium | FR-7.7 최악 소요 시간 상한 계산·문서화(+과도 시 기본값 조정) | ADR-001 또는 `llm/README.md`에 상한 표 등재 |
| M-4 | Medium | thinking 기본 활성 + 8192 출력 토큰 조합의 절단 위험 실측 후 기본값/문서 정리 | 실호출 1건의 토큰 사용량을 ADR에 기록, `.env.example` 권고값 반영 |
| L-1~L-7 | Low | 위 본문 권고 반영(선택). L-2는 Phase 4(실 평가시트 반입) 전 처리 권고 | — |

---

핵심 결함 근거 코드(H-1):

```ts
function toSafeErrorMessage(error: unknown): string {
  if (error instanceof HttpStatusError) return `HttpStatusError: status=${error.status}`;
  if (error instanceof HttpTimeoutError) return error.message;
  if (error instanceof Error) return error.message;   // ← Headers.append TypeError 메시지에 키 전문 포함
  return String(error);
}
```

주요 파일 경로:
- `D:\2. Team Source\Auto QA\apps\api\src\evaluation\llm\gemini-llm-evaluation.provider.ts`
- `D:\2. Team Source\Auto QA\apps\api\src\evaluation\llm\http-retry.ts`
- `D:\2. Team Source\Auto QA\apps\api\src\evaluation\llm\gemini-schema-builder.ts`
- `D:\2. Team Source\Auto QA\apps\api\src\evaluation\llm\gemini-prompt.ts`
- `D:\2. Team Source\Auto QA\apps\api\src\evaluation\llm\env-utils.ts`
- `D:\2. Team Source\Auto QA\apps\api\src\evaluation\evaluation.module.ts`
- `D:\2. Team Source\Auto QA\apps\api\src\evaluation\evaluation.service.ts`
