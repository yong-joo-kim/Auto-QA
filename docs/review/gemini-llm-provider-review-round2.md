# Gemini LLM Provider 재검증 (Round 2, 경량)

**판정: 통과 (Pass) — 1차 차단 사유 H-1/H-2 및 M-1/M-2가 모두 실측으로 해소 확인. 회귀 없음(api 83 / pii-mask 149 / tsc 0 error). 신규 Low 2건은 차단 사유 아님**

## 1. 검토 범위

- 재검증 대상: `apps/api/src/evaluation/llm/env-utils.ts`, `http-retry.ts`, `gemini-llm-evaluation.provider.ts`, `apps/api/src/evaluation/evaluation.module.ts`, `evaluation.service.ts`(재로깅 경로), 신규 테스트 3종, `llm/README.md`, `.env.example`
- 범위 한정: 1차 리뷰 §4의 H-1 / H-2 / M-1 / M-2 해소 여부 + 회귀 + 비밀키 잔존 스캔만 검증. AC 전수 재확인은 수행하지 않음
- 검증 방법: 코드 정독 + **리뷰어가 직접 작성한 독립 스크립트**로 런타임 실측(구현자 테스트에 의존하지 않음). 컴파일 산출물(`apps/api/dist`)을 직접 require하여 로컬 스텁 HTTP 서버로 재현, Nest Logger 출력을 stdout/stderr 후킹으로 전량 캡처

## 2. 1차 대비 판정표

| ID | 1차 판정 | 2차 판정 | 실측 근거 (리뷰어 직접 재현) |
| -- | -------- | -------- | --------------------------- |
| H-1 | 미통과(차단) | 해소 | 개행 포함 합성키 `AIzaSy\nFAKE123-synthetic`로 `evaluate()` 호출 → 네트워크 호출 전 형식 오류로 실패. 에러 message/stack/로그 전량에서 `AIzaSy`·`FAKE123`·`synthetic` 0건, 로그 출력 자체가 0바이트 |
| H-1 | 2차 방어 | 해소 | `fetch`를 키 전문 포함 TypeError로 모킹 → 로그·에러 모두 `Headers.append: "[REDACTED]" ...`. 프로바이더가 새 Error로 감싸 rethrow하므로 `cause` 미설정, `EvaluationService` 재로깅 문자열에도 키 0건 |
| H-2 | 미통과(차단) | 해소 | `Retry-After: 3600` 스텁 → raw 36ms / 프로바이더 경유 9ms 만에 실패, 서버 호출 1회. 메시지 `HTTP 429 (Retry-After 상한을 초과하여 재시도를 포기합니다)`. 1시간 대기 없음 |
| H-2 | 경계 확인 | 정상 | `Retry-After: 20`(상한 이내) → 20,021ms 대기 후 재시도(호출 2회), `Retry-After: 21` → 6ms 즉시 포기(호출 1회). `RETRY_AFTER_CAP_MS=20_000` 경계가 의도대로 동작 |
| M-1 | Medium | 해소 | 헤더만 보내고 본문을 끝맺지 않는 스텁 → raw `timeoutMs=800` 에서 806ms에 `HttpTimeoutError`, 프로바이더 `GEMINI_TIMEOUT_MS=900` 에서 915ms에 중단. 본문이 느리지만 완결되는 경우(424ms)는 정상 파싱 |
| M-2 | Medium | 해소 | 429 반복 스텁 + `GEMINI_MAX_RETRIES=2` → 서버 호출 3회, 실패 로그 `attempts=3` 정확히 기록. 타임아웃 경로(`MAX_RETRIES=1`)도 `attempts=2` 기록 |

## 3. 실행 결과

| 명령 | 결과 |
| ---- | ---- |
| `pnpm --filter @auto-qa/api test` | 통과 — 6 suites / **83 tests**(1차 74 → +9) |
| `pnpm --filter @auto-qa/pii-mask test` | 통과 — 2 suites / **149 tests**(회귀 없음) |
| `pnpm --filter @auto-qa/api exec tsc -p tsconfig.json` | **exit 0, 0 error**(dist 정상 emit) |
| 비밀키 스캔(`git grep`, 워킹트리 전수, 스크래치패드) | 저장소 내 `AIza` 매치는 합성키(`...not-a-real-secret`)와 1차 리뷰 문서뿐. 실제 키는 `.env`(gitignore 대상)에만 존재 |

## 4. 발견 사항

### L-8 (Low, 신규 — M-1 수정의 부작용) null-body 상태코드(204/205/304)가 오도된 네트워크 오류로 재시도된다

- 위치: `apps/api/src/evaluation/llm/http-retry.ts:96-100`
- 내용: 본문 버퍼링을 위해 `new Response(bodyText, { status: response.status, ... })`로 재구성하는데, 204 등 null-body 상태는 Response 생성자가 거부한다. 실측 결과 `HttpNetworkError: Response constructor: Invalid response status code 204`로 변환되어 **재시도까지 발생**(`maxRetries=1`에서 서버 호출 2회).
- 영향: Gemini `generateContent`가 204를 반환할 일은 사실상 없어 실무 위험은 낮으나, 프록시/게이트웨이가 개입하면 원인 오판을 유발한다.
- 권고: `if (response.status === 204 || response.status === 205 || response.status === 304)`면 버퍼링을 건너뛰고 그대로 반환하거나, `bodyText === '' ? null : bodyText`로 본문을 넘긴다.

### L-9 (Low, 신규) API 키 형식 검증 전에 `trim()`을 하지 않는다

- 위치: `apps/api/src/evaluation/llm/env-utils.ts:46-55`(패턴 `^[\x21-\x7e]+$`), 호출부 `evaluation.module.ts:57`, `gemini-llm-evaluation.provider.ts:57`
- 내용: `GEMINI_API_KEY=키 `(후행 공백)처럼 이전에는 헤더 정규화로 동작하던 값이 이제 기동 실패가 된다. 메시지가 명확하고 fail-fast 원칙과 일관되므로 결함이라기보다 트레이드오프지만, 검증 전 `trim()` 한 번이면 운영자 혼선을 줄일 수 있다(키 값은 여전히 출력하지 않음).

### 참고(정보성, 조치 불요)

- **H-2 상한의 의미**: 캡 20초는 "요청 전체"가 아니라 "재시도 1회당"이다. `Retry-After: 20`이 지속되면 프로바이더 1회 호출이 `maxRetries × 20초` 만큼 지연될 수 있다(실측 20.02초/회). ADR-001 D-8의 최악 상한(프로바이더 1회 ≈182초 / 전체 ≈364초) 범위 안이므로 무제한 지연은 해소됐다. NFR-4.1(P50 30초) 관점에서 추후 캡을 10초로 낮추는 선택지는 여전히 유효하다.
- **M-3 / M-4 / L-3**: 이번 범위 밖이나 산출물 존재는 확인했다 — `llm/README.md` §최악 소요 시간 상한(ADR-001 D-8 참조), §결정론성은 mock 전용(L-3), `.env.example`의 thinking/출력 토큰 실측 주석(M-4).
- **임시 실호출 테스트 파일**: 저장소 워킹트리에는 잔존물이 없다(untracked 목록 전수 확인). 세션 스크래치패드에 검증 스크립트가 남아 있으나 **저장소 밖**이며 키를 하드코딩하지 않고 실행 시 `.env`를 읽는 구조라 유출 위험은 없다(삭제 권장, 차단 사유 아님).
- **캐리오버**: 1차의 L-1/L-2/L-4~L-7은 이번 범위에서 재확인하지 않았다. 특히 L-2(itemId 중복 시 G-2 스키마 붕괴)는 Phase 4(실 평가시트 반입) 전 처리 권고를 유지한다.

## 5. 종합 의견

- **Pass — 다음 단계(test-automation) 진행 가능.** 1차의 차단 사유 2건(H-1 비밀키 로그 노출 경로, H-2 무제한 재시도 지연)은 코드 정독과 독립 런타임 실측 양쪽에서 해소가 확인됐다. H-1은 "기동/호출 진입부 형식 검증(1차 방어) + `toSafeErrorMessage(error, apiKey)` 치환(2차 방어) + 정제된 새 Error로 감싸 rethrow(서비스 재로깅 차단)"의 3중 구조로, 1차 권고 3개를 모두 반영했다.
- M-1/M-2도 요구한 완료 판정 방법(본문 스톨 스텁, 429 반복 + `MAX_RETRIES=2` → `attempts=3`) 그대로 재현해 충족을 확인했다.
- 신규 발견은 Low 2건뿐이며 모두 실패 경로의 진단성/편의 개선 수준이다. 커밋 전 수정하면 좋지만 차단하지 않는다.
- 회귀 없음: api 83 tests(신규 9건 포함) / pii-mask 149 tests 전량 통과, 타입체크 0 error. 기본 `pnpm test`가 실 Gemini API를 호출하지 않는 성질(AC-10)도 유지된다.

핵심 파일 경로:
- `D:\2. Team Source\Auto QA\apps\api\src\evaluation\llm\env-utils.ts`
- `D:\2. Team Source\Auto QA\apps\api\src\evaluation\llm\http-retry.ts`
- `D:\2. Team Source\Auto QA\apps\api\src\evaluation\llm\gemini-llm-evaluation.provider.ts`
- `D:\2. Team Source\Auto QA\apps\api\src\evaluation\evaluation.module.ts`
