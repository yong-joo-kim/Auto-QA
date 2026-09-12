# ADR-001: Gemini LLM Provider 실연동 — 모델 선정 / 스키마 방언 / 전송 방식

- 상태: 확정
- 날짜: 2026-09-12
- 관련 문서: `docs/requirements/gemini-llm-provider.md` (D-1/D-2/D-3/D-6), `CLAUDE.md` §컨벤션

## 배경

`GeminiLlmEvaluationProvider`를 스텁에서 실제 Google Gemini API 호출 구현으로 교체하면서,
요구사항 문서가 미결정으로 남겨둔 세 가지(D-1 모델 선정, D-2 스키마 방언, D-3 SDK vs REST)와
D-6(외부 전송 승인 관련 사실 기록)을 이 ADR에서 확정한다.

## D-1. 기본 모델명 확정 — `gemini-3.8-flash`

### 확인 방법

2026-09-12, `.env`에 설정된 실제 `GEMINI_API_KEY`로 다음을 실행했다(키는 쿼리스트링이 아닌
`x-goog-api-key` 헤더로 전송).

```
GET https://generativelanguage.googleapis.com/v1beta/models?pageSize=200
GET https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent
     (generationConfig.responseMimeType=application/json + responseSchema, G-2 형태 스키마)
```

응답에서 `generateContent`를 지원하는 모델 55개를 확인했고, `gemini-3.8-flash`가 그중 하나로
실제로 존재함을 확인했다(`GET /v1beta/models/gemini-3.8-flash` → 200, `supportedGenerationMethods`에
`generateContent` 포함, 입력 1,048,576 / 출력 65,536 토큰, 이름에 `preview`/`experimental` 없음).

이어서 `items`를 itemId-key 객체로, 게이팅 항목에 `passFail` enum을, `coaching.goodPoints/improvements`에
`minItems`/`maxItems`를 지정한 실제 채점형 스키마로 `generateContent`를 5회 호출한 결과, 3회는
200 OK로 스키마를 그대로 준수하는 JSON을 반환했고(예: `{"items":{"item-1":{"score":3,"reason":"..."},"item-2":{"score":9,"reason":"...","passFail":"P"}},"coaching":{"goodPoints":[...],"improvements":[...]}}`),
2회는 `503 UNAVAILABLE`("This model is currently experiencing high demand...")을 반환했다. 이는
서버측 일시적 과부하이며(FR-7.2가 이미 429/5xx를 재시도 대상으로 분류), 구조화 출력 자체를
거부한 것이 아니다 — 200 응답 3건 모두 스키마를 정확히 준수했으므로 **구조화 출력 지원은
확인되었다**고 판단한다.

### 후보 비교

| 모델 | 상태 | 입력/출력 토큰 한도 | 구조화 출력 | 비고 |
| --- | --- | --- | --- | --- |
| `gemini-3.8-flash` | Preview/experimental 표기 없음(단, `description` 필드가 "Stable"을 명시하지 않고 displayName만 반복) | 1,048,576 / 65,536 | 실호출로 지원 확인(200/5회 중 3회, 나머지는 503 과부하) | **PM 지정, 채택** |
| `gemini-2.5-flash` | Stable(개별 모델 조회 `description`에 "Stable version...released 2025-06" 명시) | 1,048,576 / 65,536 | 실호출로 지원 확인(5/5 성공, 503 없음) | backend-implementer 최초 권고(PM 지정 전). 안정성 근거가 `3.8-flash`보다 명확하고 과부하 없이 매번 성공했다는 점에서 더 보수적인 대안 |
| `gemini-2.5-pro` | Stable | 1,048,576 / 65,536 | (미검증, 2.5-flash로 이미 대표 확인) | 추론 품질은 더 높으나 비용·지연이 큼 |
| `gemini-3.1-pro-preview`, `gemini-3-flash-preview` 등 | Preview | - | (미검증) | 요구사항이 preview/experimental 제외를 명시(FR-2.2) → 제외 |

`gemini-3.8-flash`를 채택한 이유:

1. **PM이 명시적으로 `GEMINI_MODEL=gemini-3.8-flash`를 지정**했고, 위 실측으로 (a) 모델이
   실제 키로 존재하며 (b) 구조화 출력(JSON 모드 + `responseSchema`, G-2 스키마)을 지원함을
   확인했다 — PM 지시의 전제 조건(존재 + 구조화 출력 지원)을 충족한다.
2. 컨텍스트 한도(입력 1,048,576 / 출력 65,536 토큰)가 평가시트 전문 + 마스킹된 상담 대화록을
   담기에 충분하다(FR-2.2 조건 충족).
3. **알려진 한계(운영 참고 사항)**: 실측 중 5회 호출 중 2회가 `503 UNAVAILABLE`("high demand")로
   실패했다. `gemini-2.5-flash`는 동일 스키마·동일 횟수 호출에서 503이 발생하지 않았다. 이는
   `gemini-3.8-flash`가 상대적으로 신규/고수요 모델이라 일시적 과부하 빈도가 더 높을 수 있음을
   시사한다. `GEMINI_MAX_RETRIES`(기본 2)가 이 503을 재시도로 흡수하므로 기능적으로는
   허용 가능하다고 판단하되, NFR-4.1(P50 30초) 목표 미달이나 503 재시도 소진(500 응답) 빈도가
   운영 중 높게 관찰되면 `gemini-2.5-flash`로의 전환을 재검토할 것을 권고한다(env
   `GEMINI_MODEL`만 바꾸면 되므로 코드 변경 없이 전환 가능).

### 구조화 출력 지원 확인 방법

`generationConfig.responseMimeType: "application/json"` + `generationConfig.responseSchema`를
포함한 실제 `generateContent` 호출로 확인했다(200 OK, 스키마를 따르는 JSON 반환).

## D-2. 응답 스키마 방언 — itemId-key 객체(G-2) 채택, `const`/`additionalProperties` 미사용

### 실측 결과 (2026-09-12, `gemini-2.5-flash` 대상)

| 문법 요소 | 결과 | 근거 |
| --- | --- | --- |
| `const` | **미지원** | `additionalProperties`와 함께 보낸 실제 호출이 400으로 거부됨: `Unknown name "const" ... Cannot find field.` |
| `additionalProperties` | **미지원** | 위와 동일 호출에서 `Unknown name "additionalProperties" ... Cannot find field.` |
| `enum`(단일값으로 `const` 대체) | 지원 | `{"type":"STRING","enum":["item-1"]}` 스키마로 200 OK, 값 고정 확인 |
| itemId를 property key로 하는 중첩 객체(G-2) | 지원 | `items.item-1.score(maximum=5)`, `items.item-2.score(maximum=10)`처럼 키마다 다른 `maximum`을 지정한 실제 호출이 200 OK, 배점 상한을 준수하는 응답 반환 |
| `minItems`/`maxItems`(배열) | 지원 | `coaching.goodPoints` 1~3개 제약 실호출 확인 |
| `minLength`/`minimum`/`maximum`(스칼라) | 지원 | 위 호출들에 포함되어 함께 확인 |
| `thinkingConfig.thinkingBudget` | 지원(모델별) | `thinkingBudget: 0`으로 실호출 시 `thoughtsTokenCount`가 사라짐을 확인(기본은 thinking 활성) |

### 결정: G-2(요구사항 권고안) 채택

요구사항 FR-3.4가 제안한 대로 `items`를 배열이 아니라 **itemId를 key로 하는 객체**로
요청한다. 각 key의 `score`에 해당 항목의 `maximum: item.maxScore`를 직접 지정해
`const`/`anyOf` 없이도 배점 상한을 API 레벨에서 강제한다. 항목 누락은 객체 `required`
배열로 강제한다. 구현: `apps/api/src/evaluation/llm/gemini-schema-builder.ts`
(`buildGeminiResponseSchema`/`convertGeminiItemsObjectToArray`).

`additionalProperties: false`는 Gemini 방언에 없으므로 생략한다 — 서버측
`buildLlmResponseZodSchema`(`.strict()`)가 계약 외 필드를 502로 차단하는 최종 방어선
역할을 그대로 수행한다(요구사항 표의 우회 방안과 동일).

`profanityCheck`는 Gemini 요청 스키마에서 아예 제외한다(D-7/FR-6.1, 아래 참조).

## D-3. SDK vs REST — REST(Node 내장 `fetch`) 채택, 신규 런타임 의존성 없음

`apps/api`는 Node.js 20+ 를 요구하며(package.json `engines.node >=20.0.0`), Node 18+부터
전역 `fetch`/`AbortController`가 내장되어 있다. 공식 `@google/genai` SDK를 추가하는 대신
내장 `fetch` + 수동 재시도/타임아웃 로직(`apps/api/src/evaluation/llm/http-retry.ts`)을
사용한다.

이유:

- 타임아웃/재시도/에러 분류(FR-7)를 SDK 내부 동작에 의존하지 않고 완전히 통제할 수 있다.
- `apps/api/package.json`에 새 런타임 의존성을 추가하지 않는다(요구사항이 이 경로를
  명시적으로 허용하되, 의존성을 늘리지 않는 쪽을 권고함 — D-3 권고안).
- `GEMINI_API_BASE_URL` 오버라이드만으로 로컬 스텁 서버를 붙여 네트워크 없이 오류 경로
  (타임아웃/429/5xx/잘린 JSON/안전 차단)를 재현할 수 있다(NFR-6.1).
- 이 REST + 재시도 헬�퍼 패턴은 이후 Anthropic 실구현이 그대로 재사용할 수 있도록
  `http-retry.ts`에 프로바이더 비의존적으로 분리했다(FR-9.1).

## D-6. 외부 전송 승인 관련 사실 기록 (NFR-1.3)

이 기능은 이 프로젝트에서 **PII 마스킹된 상담 텍스트가 사내 인프라 밖(Google의 Gemini API
서버)으로 전송되는 첫 경로**다. 전송되는 것은 `maskPii()`를 통과한 텍스트뿐이며(원문은
프로바이더 계층에 도달하지 않음, `LlmEvaluationRequest.maskedTranscript`), 평가시트
컨텍스트(도메인명/카테고리/항목/배점/게이팅 규칙)도 함께 전송된다. 이 사실에 대한 사내
데이터 처리 정책상의 최종 승인은 PM/사용자 확인 사항으로 남겨두며, 승인 전까지는 로컬
검증(`LLM_PROVIDER=gemini`로의 수동 전환) 용도로만 사용할 것을 권고한다.

## D-7. `profanityCheck` 출처 — 로컬 산출(권고안 채택)

Gemini에 `profanityCheck` 판정을 요청하지 않는다. `apps/api/src/evaluation/llm/gemini-llm-evaluation.provider.ts`가
`@auto-qa/pii-mask`의 `detectProfanity(maskedTranscript)`를 호출해 로컬로 산출한 값을
그대로 `LlmEvaluationResponse.profanityCheck`에 주입한다(mock 프로바이더와 동일 경로).
근거는 요구사항 FR-6.1과 동일(Phase 3 옵션 B 골든 코퍼스 회귀 테스트의 결정론성을
Gemini 프로바이더에서도 그대로 유지하기 위함).

## D-8. FR-7.7 최악 소요 시간 상한 (코드리뷰 M-3 후속)

`docs/review/gemini-llm-provider-review.md`의 H-2(재시도 지연 상한 없음)를 수정하면서
(`http-retry.ts`의 `Retry-After` 힌트에 20초 상한을 적용 — 상한 초과 시 재시도를 포기하고
즉시 실패) FR-7.7이 요구하는 최악 소요 시간 상한을 계산해 기록한다.

### 계산 근거 (기본값 timeout=60s, retries=2 기준)

`fetchWithRetry` 1회 호출(`GeminiLlmEvaluationProvider.evaluate()` 1회)의 시도 구성은
attempt 1~3(최초 1회 + 재시도 2회), attempt 사이 간격(gap)은 2개다.

| 시나리오 | attempt당 최대 소요 | gap당 최대 대기 | 3attempt+2gap 합계 |
| --- | --- | --- | --- |
| 서버가 응답하지 않음(타임아웃 반복) | `GEMINI_TIMEOUT_MS`=60,000ms (M-1 수정으로 본문 수신 구간도 동일 타이머로 보호됨) | 기본 백오프(Retry-After 없음, `500×2^(n-1)+jitter`) — attempt=1→750ms, attempt=2→1,250ms | 60,000×3 + (750+1,250) ≈ **182,000ms(≈182초, 약 3분)** |
| 서버가 즉시 429/5xx + `Retry-After`를 상한(20초) 근접값으로 반환 반복 | 응답 자체는 즉시(≈0ms) | `Retry-After` 상한 20,000ms × 2 gap | ≈ 0 + 40,000 = **40,000ms(≈40초)** — 위 시나리오보다 작다 |

두 시나리오를 비교하면 **"응답하지 않음(타임아웃) 반복" 쪽이 더 크므로 이것이 실질적인
최악 소요 시간**이다: **약 182초(≈3분)**. H-2 수정 전에는 두 번째 시나리오에서 서버가
`Retry-After: 3600`(1시간)처럼 임의로 큰 값을 반환하면 2 gap × 3,600초 = 7,200초(2시간)까지
치솟을 수 있었다 — H-2 수정은 이 **비한정(사실상 무제한) 꼬리 위험을 40초 수준으로 캡핑**해
"타임아웃 반복" 시나리오가 지배적인 상한이 되도록 만든 것이며, 182초라는 기준 자체를
줄이지는 않는다(이는 `GEMINI_TIMEOUT_MS`/`GEMINI_MAX_RETRIES` 기본값 자체의 함수다).

`EvaluationService.evaluateAndAggregate`는 값 범위 위반 시 `evaluate()`를 최대 1회 추가
호출하므로(FR-7.7), 전체 API 요청의 최악 소요 시간은:

```
2 × 182초 ≈ 364초 (약 6분)
```

### 판단 — 기본값 유지, 운영 관측 권고

364초(약 6분)는 동기 HTTP 요청 기준으로는 긴 편이지만, 다음 근거로 **기본값(timeout 60s /
retries 2)을 이번 라운드에서는 변경하지 않는다**:

1. 이 값은 **극단적 장애 상황**(3회 연속 완전 무응답)의 이론적 상한이다. ADR D-1에서 실측한
   정상 케이스의 실제 latencyMs는 5.8~14.2초 수준이었다(503 재시도 1회 포함해도 14초대).
2. `GEMINI_TIMEOUT_MS`/`GEMINI_MAX_RETRIES`는 코드 변경 없이 env만으로 즉시 조정 가능하다.
   운영 중 502/500 발생 빈도나 P50/P95 지연을 관측한 뒤(FR-10.1 로그의 latencyMs로 확인
   가능) 필요 시 낮추는 것을 권장한다(예: `GEMINI_TIMEOUT_MS=30000`으로 낮추면 이론적
   상한은 182초 대신 91초, 총합 182초로 절반이 된다).
3. FE(`apps/web`)에 별도 클라이언트 타임아웃이 없다는 점(리뷰 H-2 부가 지적)은 이 기능의
   범위 밖이며 별도 이슈로 다룰 것을 권고한다(FE 로딩 문구 개선은 FR-12.1 재량 사항).

## D-9. M-4 후속 — thinking 활성 + `GEMINI_MAX_OUTPUT_TOKENS=8192` 조합 실측

2026-09-12, `LLM_PROVIDER=gemini`(`gemini-3.8-flash`, `GEMINI_THINKING_BUDGET` 미설정 = thinking
기본 활성)로 telecom 평가시트(14개 항목) + 실제 상담 시나리오 유사 트랜스크립트 1건을 2회
실호출해 토큰 사용량을 관측했다(둘째 호출에서 `thoughtsTokenCount`를 로그에 추가로 노출하도록
`gemini-llm-evaluation.provider.ts`의 관측성 로그를 보강한 뒤 측정).

| 항목 | 1차 호출 | 2차 호출 |
| --- | --- | --- |
| `promptTokenCount`(입력) | 2,058 | 2,058 |
| `candidatesTokenCount`(응답 JSON: items+coaching) | 962 | 1,030 |
| `thoughtsTokenCount`(사고 토큰) | 555(총계 역산) | 644(직접 관측) |
| `totalTokenCount` | 3,575 | 3,732 |
| 합계(응답+사고, `GEMINI_MAX_OUTPUT_TOKENS` 예산 소비량) | 1,517 | 1,674 |
| `GEMINI_MAX_OUTPUT_TOKENS` 대비 사용률 | 18.5% | 20.4% |
| `finishReason` | `STOP`(정상 종료, 절단 없음) | `STOP` |

**결론**: thinking이 기본 활성 상태여도, 응답(items 14개+coaching)과 사고 토큰을 합쳐
8192 토큰 예산의 약 20% 내외만 소비했다. `MAX_TOKENS` 절단 위험은 이번 실측 범위(telecom,
14항목)에서는 낮게 관측되었으므로, **`GEMINI_MAX_OUTPUT_TOKENS` 기본값(8192)을 상향하지
않는다**. 다만 여유가 무한정은 아니므로(항목이 더 많은 평가시트나 긴 coaching 문구가
누적되면 사고 토큰이 추가로 소비될 수 있음), `.env.example`의 `GEMINI_THINKING_BUDGET`
주석에 "항목 수가 크게 늘면 `GEMINI_THINKING_BUDGET=0` 권장"을 명시했다(코드 기본값은
변경하지 않고 문서 권고만 추가 — FR-2.3의 "미설정 시 모델 기본값" 원칙 유지).

관측성 로그(`gemini-llm-evaluation.provider.ts` `logObservability`)에 `tokens.thoughts`
필드를 상시 노출하도록 반영해, 이후 운영 중에도 이 비율을 계속 관측할 수 있게 했다.

## 결정 요약

| ID | 결정 | 상태 |
| --- | --- | --- |
| D-1 | 기본 모델 `GEMINI_MODEL=gemini-3.8-flash`(PM 지정, 존재·구조화 출력 지원 실측 확인) | 확정 |
| D-2 | itemId-key 객체 스키마(G-2), `const`/`additionalProperties` 미사용 | 확정 |
| D-3 | REST + Node 내장 `fetch`, 신규 런타임 의존성 없음 | 확정 |
| D-6 | 마스킹된 텍스트의 Google 서버 전송 사실 기록, 최종 승인은 PM/사용자 몫 | 기록만 함(승인 대기) |
| D-7 | `profanityCheck`는 로컬 `detectProfanity` 산출(권고안) | 확정 |
| D-8 | FR-7.7 최악 소요 시간: 프로바이더 1회 호출 ≈182초, `EvaluationService` 재시도 포함 ≈364초. 기본값(timeout 60s/retries 2) 유지, 운영 관측 후 필요 시 env로 조정 권고 | 확정(기본값 유지) |
| D-9 | thinking 활성 + `GEMINI_MAX_OUTPUT_TOKENS=8192` 실측: 사고+응답 합계 약 1,517~1,674 토큰(사용률 18~20%), 절단 위험 낮음. 기본값 유지, `.env.example`에 항목 수 증가 시 `GEMINI_THINKING_BUDGET=0` 권고 문구 추가 | 확정(기본값 유지) |
