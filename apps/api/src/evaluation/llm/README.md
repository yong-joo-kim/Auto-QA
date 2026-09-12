# LLM Provider 공통 규약

`LlmEvaluationProvider`를 구현하는 모든 프로바이더(mock/anthropic/gemini)가 따라야 하는
공통 패턴(FR-9.2, `gemini-llm-evaluation.provider.ts`가 최초로 확립):

```
동적 스키마로 구조화 출력 요청
  → 최소 파싱(JSON.parse, 형태 변환만)
  → providerMeta 주입
  → 검증/보정은 하지 않음
  → 실패 시 throw
```

- **검증/보정 책임은 프로바이더에 없다.** 점수 clamp, 반올림, 누락 항목 채우기, 기본값 대체는
  `EvaluationService`(구조 위반 → 502 / 값 범위 위반 → 재시도 → clamp → `manual_review`)의
  책임이다. 프로바이더가 이를 대신 수행하면 방어 로직이 무력화된다.
- **재시도/타임아웃/에러 분류는 `http-retry.ts`를 공유한다.** 일시적 오류(429/5xx/네트워크/
  타임아웃)만 재시도하고, 영구적 오류(4xx 등)는 즉시 throw한다.
- **실패는 항상 throw로 표현한다.** 상태 코드 결정은 `EvaluationService.invokeProvider`(500)와
  구조 검증(502)이 담당하며, 프로바이더가 직접 HTTP 상태를 반환하지 않는다.
- **비밀키는 헤더로만 전송하고 로그/에러 메시지에 남기지 않는다.**
- **트랜스크립트 원문/프롬프트 전문/모델 응답 본문은 로그에 남기지 않는다.** 관측성 로그는
  provider/model/domainId/시도횟수/latencyMs/종료사유/토큰 사용량만 남긴다(FR-10).

## 파일 구성

| 파일 | 역할 |
| --- | --- |
| `llm-evaluation-provider.interface.ts` | 세 프로바이더 공통 요청/응답 타입 (불변 계약) |
| `schema-builder.ts` | JSON Schema 방언(Anthropic 등 표준 JSON Schema 수용 프로바이더용) + 런타임 zod 계약 |
| `gemini-schema-builder.ts` | Gemini 전용 responseSchema 방언 어댑터(`const`/`additionalProperties` 미지원 우회, itemId-key 객체 방식) |
| `gemini-prompt.ts` | Gemini 프롬프트(system instruction/user content) 템플릿 |
| `http-retry.ts` | 재시도/타임아웃/백오프 공통 헬퍼(프로바이더 비의존적) |
| `env-utils.ts` | 숫자형 env 파싱 + 기본값 대체 + 경고 로그 헬퍼 |
| `mock-llm-evaluation.provider.ts` | 결정론적 mock 구현(테스트/로컬 개발 기본값) |
| `gemini-llm-evaluation.provider.ts` | Google Gemini 실호출 구현 |
| `anthropic-llm-evaluation.provider.ts` | (아직 스텁) Anthropic 실구현 예정 — 위 패턴/헬퍼를 재사용할 것 |

## 결정론성(AC-8/AC-R-3)은 mock 전용

`gemini-llm-evaluation.provider.ts`(및 향후 `anthropic-llm-evaluation.provider.ts` 실구현)는
Phase 1 AC-8(동일 입력 2회 채점 시 결과 완전 동일)과 Phase 3 AC-R-3의 결정론성 요구 대상이
**아니다**. 실제 LLM 호출은 temperature 0에서도 완전히 동일한 출력을 보장하지 않는다
(`docs/requirements/gemini-llm-provider.md` NFR-5 참조). 결정론 기반 회귀 테스트(스냅샷 등)는
계속 `mock` 프로바이더 또는 스텁 트랜스포트로만 수행한다 — 실 프로바이더에 대해서는 계약
준수(스키마/배점 상한/항목 완전성)만 검증 대상이다.

## 프로바이더 실패 시 관측성 로그의 시도 횟수(M-2)

`http-retry.ts`의 `HttpStatusError`/`HttpTimeoutError`/`HttpNetworkError`는 모두 `attempts`
필드(실제로 수행된 시도 횟수)를 싣는다. 프로바이더의 실패 로그는 이 값을 우선 사용하고,
값이 없는 경우에만 로컬 변수를 대체 사용한다 — 재시도 소진 실패에서도 정확한 시도 횟수가
로그에 남아야 429/503 빈도 기반 운영 판단(예: ADR-001 D-1의 모델 전환 검토)이 가능하다.

## 최악 소요 시간 상한(FR-7.7)

기본값(timeout 60s / retries 2) 기준 프로바이더 1회 호출의 최악 소요 시간과, `EvaluationService`
재시도까지 포함한 API 요청 전체의 최악 소요 시간 계산 근거는
`docs/decisions/ADR-001-gemini-llm-provider.md`(D-8)에 기록되어 있다(요약: 프로바이더 1회
≈182초, 전체 ≈364초). `Retry-After` 힌트에는 상한(20초, `http-retry.ts`
`RETRY_AFTER_CAP_MS`)이 적용되어 있어, 서버가 비정상적으로 큰 `Retry-After`(예: 3600초)를
보내도 그 값만큼 대기하지 않고 즉시 실패한다(H-2).

## Anthropic 구현 시 참고사항

1. `http-retry.ts`의 `fetchWithRetry`를 그대로 사용해 타임아웃/재시도/백오프를 재구현하지 말 것.
2. Anthropic tool-use `input_schema`는 표준 JSON Schema 서브셋을 지원하므로 `schema-builder.ts`의
   `buildEvaluationResponseJsonSchema`를 그대로 사용할 수 있는지 먼저 실호출로 확인할 것
   (Gemini와 달리 `const`/`anyOf`/`additionalProperties`를 지원할 가능성이 있다 — 추측하지
   말고 실측할 것, D-1/D-2와 동일한 절차).
3. `profanityCheck`는 Gemini와 동일하게 로컬 `detectProfanity()`로 산출하는 방안을 우선
   검토할 것(Phase 3 골든 코퍼스 결정론성 유지).
4. env 네이밍 컨벤션은 `ANTHROPIC_TIMEOUT_MS`/`ANTHROPIC_MAX_RETRIES`/`ANTHROPIC_MAX_OUTPUT_TOKENS`
   등 Gemini와 대칭되는 이름을 사용할 것.
