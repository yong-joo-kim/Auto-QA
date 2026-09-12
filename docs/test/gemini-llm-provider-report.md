# Gemini LLM Provider — 테스트 리포트

- 대상 문서: `docs/requirements/gemini-llm-provider.md`(AC-1~AC-13), `docs/review/gemini-llm-provider-review.md`(1차), `docs/review/gemini-llm-provider-review-round2.md`(2차, 최종 Pass)
- 대상 코드: `apps/api/src/evaluation/llm/{gemini-llm-evaluation.provider.ts,http-retry.ts,env-utils.ts,gemini-schema-builder.ts,gemini-prompt.ts}`, `apps/api/src/evaluation/evaluation.module.ts`
- 목적: 2차 리뷰(최종 Pass)가 남긴 신규 Low 2건(L-8/L-9)을 회귀 테스트로 고정하고, AC-1~AC-13을 기존 83개 테스트와 전수 대조해 빠진 검증을 채운다.
- 원칙: **테스트 코드만 추가**했다. 2차 리뷰에서 Pass 판정을 받은 프로덕션 로직(`gemini-llm-evaluation.provider.ts`, `http-retry.ts`, `env-utils.ts`, `gemini-schema-builder.ts`, `gemini-prompt.ts`, `evaluation.module.ts`)은 전혀 수정하지 않았다. 실제 Gemini API를 호출하는 테스트는 작성하지 않았다(전부 로컬 스텁 HTTP 서버 또는 `fetch` 모킹).

---

## 1. 테스트 범위 및 목록

### 1.1 L-8 회귀(신규) — `http-retry.spec.ts`

리뷰가 실측한 대로, `fetchWithRetry`가 응답 본문을 버퍼링하려고 `new Response(bodyText, { status, ... })`로 재구성하는데, null-body 상태코드(204/205)는 Response 생성자가 상태코드 자체를 거부한다. 이 TypeError가 "네트워크 오류"로 오분류되어 `HttpNetworkError`로 재포장되고, 재시도까지 유발한다.

- **204(No Content)**: `HttpNetworkError`, 메시지에 `Invalid response status code 204` 포함, `isRetryableStatus`가 항상 false를 반환해도 최초 1회 + 재시도 1회 = **총 2회 호출**됨을 고정(오도된 재시도가 실제로 발생함을 실측 근거로 확인).
- **205(Reset Content)**: 204와 동일한 오도 경로임을 확인.
- **304(Not Modified)**: `response.ok`가 false(2xx 범위 밖)라 애초에 버퍼링 분기를 타지 않고, `isRetryableStatus` 판단에 따라 **즉시** `HttpStatusError(status=304)`로 실패함을 확인 — L-8은 204/205(2xx 범위의 null-body 상태)에서만 재현되고 304에서는 재현되지 않는 경계를 명시적으로 고정했다(리뷰 문서는 204/205/304를 함께 언급했으나, 실측 결과 304는 이 코드 경로의 결함을 유발하지 않는다).

이 3개 테스트는 모두 **"고쳐야 할 결함"이 아니라 현재 동작을 고정**한다(PM 판단 필요, §4 참조).

### 1.2 L-9 회귀(신규) — `env-utils.spec.ts`(신규 파일), `evaluation.module.spec.ts`(보강)

`assertHeaderSafeApiKeyFormat`(패턴 `^[\x21-\x7e]+$`)은 검증 전 `trim()`을 하지 않으므로, 후행/선행 공백이 섞인 키는 fail-fast된다.

- `env-utils.spec.ts`(신규): `assertHeaderSafeApiKeyFormat` 단위 테스트 — 정상 키 통과, 개행 포함 키 실패(메시지에 원본 키 미노출), **후행 공백 키 실패**(L-9), **선행 공백 키 실패**, 빈 문자열 실패. 같은 파일에서 `parseIntEnv`/`parseFloatEnv`(이전까지 전용 스펙이 없던 순수 로직)도 함께 커버했다(undefined/공백/유효값/파싱 불가 값 4분기).
- `evaluation.module.spec.ts`(보강): 모듈 부팅(E2E에 가까운 레벨)에서도 후행 공백 키가 `GEMINI_API_KEY 형식이 올바르지 않습니다`로 fail-fast됨을 고정(H-1 테스트와 동일한 스타일).

이 테스트들도 **"고쳐야 할 결함"이 아니라 현재의 트레이드오프 동작을 고정**한다(PM 판단 필요, §4 참조).

### 1.3 AC 전수 대조로 발견한 커버리지 공백 보강

| AC | 기존 83개 테스트 커버 여부 | 조치 |
| --- | --- | --- |
| AC-1(실 API e2e) | 미커버(요구사항상 수동 1회 확인 대상, 실 키 필요) | 조치 없음 — 자동화 테스트 범위 밖(요구사항 §5 AC-1 자체가 "수동 1회 + 리포트 기록"으로 명시) |
| AC-2(배점 상한/항목 완전성) | 프로바이더 레벨 passthrough만 커버(스키마 자체의 `maximum`/`required` 생성 로직은 전용 단위 테스트 없음) | **보강**: `gemini-schema-builder.spec.ts`(신규) — 항목별 `maximum` 정확성, `items.required`에 전체 itemId 포함, 게이팅 항목만 `passFail` enum·required 부여, coaching 1~3개 제약, D-2(무`const`/`additionalProperties`) 고정 |
| AC-3(구조 위반→502) | 커버(프로바이더 passthrough) + `evaluation.service.spec.ts`(제공자 비의존적 502 매핑) | 조치 없음 |
| AC-4(값 범위 위반→manual_review) | 커버 | 조치 없음 |
| AC-5(타임아웃/네트워크/429/5xx→500) | 커버(9개 시나리오) | 조치 없음 |
| AC-6(설정 누락 fail-fast) | 커버(키/모델 없음) | **보강**: L-9(후행 공백) 케이스 추가 |
| AC-7(비밀키 비노출) | 커버(H-1 3중 방어 각각) | 조치 없음 |
| AC-8(PII 전송 경로) | 커버(마스킹 텍스트 그대로 전송, 키 미노출) | 조치 없음(원문 PII 부재 자체는 `packages/pii-mask` 149개 테스트 + Phase 1/3 통합 테스트가 이미 전담) |
| AC-9(결정론성 비적용) | **미커버** — README/ADR에 "결정론 비적용"이 문서화만 되어 있고, 이를 실증하는 테스트가 없었다 | **보강**: `gemini-llm-evaluation.provider.spec.ts`에 `AC-9` describe 추가 — 동일 입력에 서로 다른 점수(스텁 응답 2종)를 주입해도 각각 오류 없이 처리되고 항목 완전성(3건)을 유지함을 확인. 관찰값(총점) `firstTotal=15`, `secondTotal=13`, 차이=2를 리포트에 기록 |
| AC-10(Provider 전환 무코드 변경) | 커버(mock 기본값 부팅 + 기존 스윗 전체 통과) | 조치 없음 |
| AC-11(profanityCheck 계약 유지) | 부분 커버 — `detected: false` 경로만 확인, `detected: true`(매치 존재) 경로 미확인 | **보강**: 비속어 포함 트랜스크립트로 `detected: true`/`matches` 1건/화자 매핑/`maskedText`에 원문 비속어 미포함을 확인. Gemini 응답에 모델이 실수로 `profanityCheck`를 보내도 무시되고 로컬 산출값으로 대체됨을 함께 고정 |
| AC-12(관측성) | 부분 커버 — 실패 로그의 `attempts` 값만 확인, 성공 로그(`Gemini 채점 완료`) 라인의 필드 전수/PII 비노출은 미확인 | **보강**: 성공 시 로그 라인에 `provider=gemini`/`model=`/`domainId=`/`attempts=`/`latencyMs=`/`finishReason=STOP`/`tokens.in`/`tokens.out`/`tokens.total`/`tokens.thoughts`가 모두 존재하고, 트랜스크립트 원문·사유 텍스트가 로그 전체 어디에도 없음을 확인 |
| AC-13(문서/설정 갱신) | 문서 확인(코드 테스트 대상 아님) | `.env.example`(`GEMINI_MODEL`/선택 env 존재, 키는 빈 값), `CLAUDE.md`(gemini 연동 완료 문구), `docs/decisions/ADR-001-*.md`(D-1/D-2/D-3 기록) 육안 재확인 — 전부 존재함을 확인, 조치 불필요 |

---

## 2. 실행 결과 요약

```
$ pnpm --filter @auto-qa/api test
PASS src/eval-sheets/eval-sheet-invariants.spec.ts
PASS src/evaluation/llm/gemini-schema-builder.spec.ts
PASS src/transcripts/transcripts.service.spec.ts
PASS src/evaluation/evaluation.service.spec.ts
PASS src/evaluation/llm/env-utils.spec.ts
PASS src/evaluation/evaluation.module.spec.ts
PASS src/evaluation/llm/http-retry.spec.ts
PASS src/evaluation/llm/gemini-llm-evaluation.provider.spec.ts

Test Suites: 8 passed, 8 total
Tests:       114 passed, 114 total   (2차 리뷰 시점 83 → +31)
```

```
$ pnpm --filter @auto-qa/pii-mask test
PASS src/mask.spec.ts
PASS src/profanity.spec.ts

Test Suites: 2 passed, 2 total
Tests:       149 passed, 149 total   (회귀 없음)
```

```
$ pnpm --filter @auto-qa/api exec tsc -p tsconfig.json --noEmit
(0 error, exit 0)
```

- **전체 263개 테스트(114 + 149), 263건 통과 / 0건 실패.**
- 신규 31개 테스트의 내역: `env-utils.spec.ts` 13개(신규 파일), `gemini-schema-builder.spec.ts` 11개(신규 파일), `http-retry.spec.ts` +3(L-8), `evaluation.module.spec.ts` +1(L-9), `gemini-llm-evaluation.provider.spec.ts` +3(AC-9 1, AC-12 1, AC-11 1).
- 기존 83개(api)/149개(pii-mask) 테스트는 전부 그대로 통과했다(회귀 없음).
- `apps/web`에는 이 기능과 관련된 변경이 없다(요구사항 FR-12 결론 — UI 변경 없음). `pnpm --filter web test` 스크립트 자체가 기존에 없으므로 실행 대상에서 제외했다(Phase 3 리포트 이후 상태와 동일).
- 비밀키 스캔: 이번에 추가/수정한 5개 테스트 파일 전체에서 `AIza` 매치는 전부 기존 컨벤션과 동일한 합성 키(`AIzaSyValidKey-123_456`, `AIzaSy\nFAKE123-not-a-real-secret` 등, `-not-a-real-secret`/`FAKE` 접미사 포함)뿐이다. `.env`의 실제 키는 어떤 시점에도 `cat`하거나 출력하지 않았다(값 존재 여부만 필요 시 `grep -c`류로 확인).
- 실제 Gemini API를 호출하는 테스트는 없다(전부 로컬 HTTP 서버 스텁 또는 `global.fetch` 모킹). 기본 `pnpm test`가 실 API를 호출하지 않는 성질(AC-10)이 이번 추가로도 유지된다.

---

## 3. 실패 원인 분석

이번 실행에서 실패한 테스트는 없다. 다만 테스트 작성 과정에서 사전 조사가 필요했던 지점을 기록한다(전부 테스트 설계 단계에서 해소, 프로덕션 코드 결함 아님):

- L-8 테스트를 작성하기 전, 실제로 어느 상태코드에서 어떤 예외가 나는지 사전 실측이 필요했다(리뷰 문서가 "204/205/304"를 함께 언급했으나, 코드를 추적한 결과 `response.ok` 분기 구조상 304는 애초에 버퍼링 코드에 도달하지 않음을 확인). 임시 탐색용 스펙 파일(`__tmp-explore.spec.ts`)로 로컬 HTTP 서버 응답을 관찰한 뒤 삭제하고, 확인된 사실만 정식 테스트로 고정했다(스크래치 파일은 저장소에 남기지 않았다 — `git status`로 확인).
- AC-9 테스트의 "관찰값"(firstTotal=15/secondTotal=13)은 실제 LLM 비결정론이 아니라 **두 개의 서로 다른 스텁 응답을 준비해 흉내낸 것**이다. 실제 Gemini 호출의 점수 편차 크기는 이 테스트로 측정할 수 없으며(그 목적이 아님), 이 테스트는 "값이 달라도 프로바이더가 이를 오류로 취급하지 않는다"는 코드 레벨 성질만 고정한다.

---

## 4. L-8 관련 PM 판단 필요 사항

2차 리뷰가 지적한 대로, L-8은 **차단 사유가 아닌 Low**다. 이번 테스트로 다음 현재 동작이 확정적으로 고정되었다.

- Gemini `generateContent`가 204/205를 반환하는 경우는 사실상 없다(정상 200 또는 4xx/5xx 오류 상태만 실무에서 관측됨). 따라서 이 결함이 실제 운영에서 발동할 가능성은 낮다.
- 다만 프록시/게이트웨이/로드밸런서가 개입해 204/205를 반환하는 극단적 상황이 생기면, 실제로는 "정상 무응답"인 상황이 "네트워크 오류"로 오분류되어 불필요한 재시도(그리고 관측성 로그에 `HttpNetworkError`로 오기록)를 유발한다. 재시도가 모두 실패하면 이는 500으로 매핑되어 저장 없이 사용자에게 실패 안내가 나가는데, 실제로는 "정상 처리 가능했던" 상황을 실패로 오판하는 것이다.
- 수정 자체는 리뷰가 제시한 대로 작지만(예: `response.status`가 204/205/304면 버퍼링을 건너뛰고 그대로 반환, 또는 `bodyText === '' ? null : bodyText`), **이번 라운드는 테스트만 추가하는 범위**이므로 프로덕션 코드는 그대로 두었다.
- **PM 판단 필요**: (a) 발생 가능성이 낮고 최종적으로도 500(저장 없음, 재시도 버튼 제공)으로 안전하게 귀결되므로 이대로 두고 다음 기능 라운드에서 처리할지, 아니면 (b) 지금 `backend-implementer`를 재호출해 즉시 고칠지 결정이 필요하다. 어느 쪽을 택하든 이번에 추가한 3개 테스트(`http-retry.spec.ts`의 L-8 describe)가 **현재 동작을 고정**하므로, 코드를 수정하면 204/205 테스트 2개는 기대값을 "정상 처리(재시도 없음)"로 바꿔야 하고 304 테스트는 그대로 유지될 것이다.

L-9(trim 미실시)도 동일하게 "결함이라기보다 트레이드오프"라는 리뷰 판정을 그대로 따라 테스트만 고정했다. `trim()`을 추가하기로 결정하면 `env-utils.spec.ts`의 L-9 테스트 2건과 `evaluation.module.spec.ts`의 L-9 테스트 1건이 실패하도록 설계되어 있으므로, 수정 시 이 3개 테스트를 함께 갱신해야 함을 인지하고 있어야 한다.

---

## 5. 커버리지가 부족한 영역 (참고, 이번 라운드에서 미조치)

- **AC-1(실 API e2e)**: 요구사항 자체가 "수동 1회 + 리포트 기록"으로 명시했고, 실제 키로 호출하는 자동화 테스트를 만들지 말라는 이번 지시와도 일치한다. ADR-001 D-1/D-2/D-9가 이미 실측 기록을 담고 있으므로 별도 조치를 하지 않았다.
- **`gemini-prompt.ts`(프롬프트 텍스트 생성)의 전용 단위 테스트 부재**: `buildGeminiSystemInstruction`/`buildGeminiUserContent`는 순수 함수이지만, FR-4가 요구하는 문구(마스킹 placeholder 설명, PII 복원 시도 금지 지시 등)가 실제로 프롬프트 문자열에 포함되는지를 직접 검증하는 스펙이 없다(현재는 프로바이더 스펙에서 요청 본문에 마스킹 텍스트가 포함되는지만 간접 확인). 프롬프트 문구는 채점 품질에 영향을 주지만 "계약 위반"을 유발하지 않는 영역이라 이번 라운드의 우선순위(L-8/L-9/AC 감사)에서는 제외했다 — 후속 라운드에서 프롬프트 문구를 조정할 계획이 있다면 스냅샷/포함 여부 테스트 추가를 권고한다.
- **L-2(itemId 중복 시 스키마 붕괴, 1차 리뷰 캐리오버)**: 2차 리뷰가 "Phase 4(실 평가시트 반입) 전 처리 권고"로 명시적으로 이번 범위 밖에 둔 항목이라 테스트를 추가하지 않았다.
- **HTTP 레벨 통합 테스트(`POST /transcripts` → `GET /transcripts/:id`, `LLM_PROVIDER=gemini` 경로)**: 이번 스펙들은 모두 `GeminiLlmEvaluationProvider`/`EvaluationModule` 단위 레벨이며, 컨트롤러까지 포함한 e2e 테스트는 Phase 1/3 리포트에서도 계속 미해결로 남아있는 영역이다(별도 과제로 재확인만 함, 이번 라운드에서 신규로 만들지 않음).

---

## 6. 산출물 경로

- `D:\2. Team Source\Auto QA\apps\api\src\evaluation\llm\env-utils.spec.ts` (신규 — `parseIntEnv`/`parseFloatEnv`/`assertHeaderSafeApiKeyFormat` 단위 테스트, L-9 포함)
- `D:\2. Team Source\Auto QA\apps\api\src\evaluation\llm\gemini-schema-builder.spec.ts` (신규 — AC-2/FR-3.4 스키마 생성 + 형태 변환 단위 테스트)
- `D:\2. Team Source\Auto QA\apps\api\src\evaluation\llm\http-retry.spec.ts` (보강 — L-8 204/205/304 회귀 테스트 3건 추가)
- `D:\2. Team Source\Auto QA\apps\api\src\evaluation\evaluation.module.spec.ts` (보강 — L-9 후행 공백 fail-fast 테스트 1건 추가)
- `D:\2. Team Source\Auto QA\apps\api\src\evaluation\llm\gemini-llm-evaluation.provider.spec.ts` (보강 — AC-9 결정론성 비적용 1건, AC-12 성공 로그 관측성 1건, AC-11 비속어 탐지 경로 1건 추가)

---

## 7. L-8~L-11 핫픽스 라운드 (2026-09-13, 회귀 테스트 보강)

2차 리뷰(round2, Pass) 이후 PM이 L-8/L-9/L-10/L-11(전부 Low)을 전부 지금 수정하기로 결정하고, `backend-implementer`가 프로덕션 코드를 먼저 고쳤다(이 라운드에서는 프로덕션 코드를 전혀 수정하지 않았다 — 이미 반영된 변경 확인 후 회귀 테스트만 추가했다). 그 과정에서 code-reviewer가 새로 발견한 L-12(Low, 미반영이던 커버리지 공백)도 함께 테스트로 고정했다.

### 7.1 이미 반영된 프로덕션 코드 변경(확인만 함, 이번 라운드에서 수정하지 않음)

- **L-8** `http-retry.ts`: `fetchWithRetry`가 204/205 상태코드는 버퍼링(Response 재구성) 없이 원본 response를 그대로 반환하도록 수정. 기존 `http-retry.spec.ts`의 L-8 describe(204/205/304)는 이미 새 동작("정상 처리, attempts=1")으로 갱신되어 있었다(이번 라운드에서 추가로 손대지 않음).
- **L-9** API 키 trim: `evaluation.module.ts`/`gemini-llm-evaluation.provider.ts`에서 `GEMINI_API_KEY`를 읽은 직후 `.trim()`. 기존 `evaluation.module.spec.ts`의 L-9 테스트는 이미 "후행 공백 키로 부팅 성공"으로 갱신되어 있었다.
- **L-10** `gemini-llm-evaluation.provider.ts`: 응답 본문을 `response.json()` 대신 `response.text()`로 먼저 읽고, 빈 문자열이면 `{}`로 취급(→ 이후 `extractGeminiCandidateText`가 "candidate가 없습니다"로 실패시킴), 파싱 자체가 실패하면 "Gemini 응답 본문 JSON 파싱에 실패했습니다 (model=...)" 메시지로 던지도록 변경. **이번 라운드에서 회귀 테스트 신규 작성**(§7.2).
- **L-11** `GEMINI_MODEL`도 `GEMINI_API_KEY`/`GEMINI_API_BASE_URL`과 동일하게 읽는 즉시 `.trim()`(`evaluation.module.ts`, `gemini-llm-evaluation.provider.ts` 둘 다). **이번 라운드에서 회귀 테스트 신규 작성**(§7.2).

### 7.2 이번 라운드에서 신규 작성한 테스트(전부 `gemini-llm-evaluation.provider.spec.ts`에 추가, 테스트 코드만 변경)

**L-12(신규 발견, Low)**: 공백이 낀 `GEMINI_API_KEY`가 trim되어 실제 HTTP 요청의 `x-goog-api-key` 헤더에 반영되는지 직접 단언하는 테스트가 없었다(기존에는 "모듈 부팅 성공"까지만 확인). 로컬 스텁 서버가 실제로 수신한 헤더 값을 캡처해 검증하는 테스트 1건을 `describe('L-12: ...')`로 추가했다 — 앞뒤 공백이 섞인 키를 env로 주입하고, 스텁 서버가 받은 `x-goog-api-key` 헤더가 trim된 키와 정확히 일치하며 공백을 포함하지 않음을 확인한다(trim이 누락되면 애초에 `assertHeaderSafeApiKeyFormat`이 공백 문자를 거부해 네트워크 호출 전에 형식 오류로 실패하므로, 이 테스트는 trim 유무 자체를 간접적으로도 검출한다).

**L-10 회귀**: `describe('L-10: ...')`에 3건 추가.
- 204(빈 본문) 응답 → 원시 `Unexpected end of JSON input`이 아니라 "Gemini 응답에 candidate가 없습니다" 메시지로 실패함을 확인.
- 본문 자체가 JSON이 아닌 경우(200 상태에 일반 텍스트 본문) → "Gemini 응답 본문 JSON 파싱에 실패했습니다" 메시지로 실패함을 확인(기존 "AC-5 유사: JSON 파싱 실패 시..." 테스트는 *candidate 내부 text 필드*가 JSON이 아닌 경우 — "Gemini 응답 JSON 파싱에 실패했습니다" — 를 다루므로 서로 다른 코드 경로/메시지를 구분해 각각 고정했다).
- 통합 테스트: 204 응답을 실제 `EvaluationService.evaluateAndAggregate()`에 흘려보내(`GeminiLlmEvaluationProvider`를 직접 주입) `invokeProvider`가 어떤 provider 에러든 그대로 감싸는 기존 동작에 따라 `InternalServerErrorException`(status 500)으로 안전하게 매핑되고, 최종 에러 메시지가 고정된 안내 문구("LLM 채점 요청 처리 중 오류가 발생했습니다...")뿐이며 원시 파싱 에러 문구나 "candidate" 같은 내부 문구가 전혀 노출되지 않음을 확인.

**L-11 회귀**: `describe('L-11: ...')`에 2건 추가.
- 앞뒤 공백이 섞인 `GEMINI_MODEL`(예: `'  gemini-test-model  '`)이 trim되어 (a) fail-fast 검증을 통과하고 (b) 실제 요청 URL(`req.url`)에 `%20` 없이 정확한 모델명(`/v1beta/models/gemini-test-model:generateContent`)으로 들어감을 확인.
- 공백만 있는 `GEMINI_MODEL`(`'   '`)은 trim 후 빈 문자열이 되어 기존 fail-fast 메시지("GEMINI_MODEL이 설정되지 않았습니다")로 실패함을 확인.

### 7.3 실행 결과

```
$ pnpm --filter @auto-qa/api test
PASS src/evaluation/llm/gemini-schema-builder.spec.ts
PASS src/eval-sheets/eval-sheet-invariants.spec.ts
PASS src/evaluation/llm/env-utils.spec.ts
PASS src/transcripts/transcripts.service.spec.ts
PASS src/evaluation/evaluation.service.spec.ts
PASS src/evaluation/evaluation.module.spec.ts
PASS src/evaluation/llm/http-retry.spec.ts
PASS src/evaluation/llm/gemini-llm-evaluation.provider.spec.ts

Test Suites: 8 passed, 8 total
Tests:       120 passed, 120 total   (이전 114 → +6: L-12 1건, L-10 3건, L-11 2건)
```

```
$ pnpm --filter @auto-qa/pii-mask test
Test Suites: 2 passed, 2 total
Tests:       149 passed, 149 total   (회귀 없음)
```

```
$ pnpm --filter @auto-qa/api exec tsc -p tsconfig.json --noEmit
(0 error, exit 0)
```

- **전체 269개 테스트(api 120 + pii-mask 149), 269건 통과 / 0건 실패.**
- 신규 6개 테스트는 모두 `gemini-llm-evaluation.provider.spec.ts`에 추가했다(L-12 1개, L-10 3개, L-11 2개). `http-retry.spec.ts`/`env-utils.spec.ts`/`evaluation.module.spec.ts`는 이전 라운드에서 이미 L-8/L-9 갱신이 끝나 있어 이번 라운드에서는 손대지 않았다.
- 이번에 추가한 L-10 통합 테스트를 위해 `EvaluationService`를 직접 `new`로 인스턴스화해 `GeminiLlmEvaluationProvider`를 주입했다(Nest 테스팅 모듈 없이 생성자 직접 호출 — `evaluation.service.ts`의 `constructor(@Inject(LLM_EVALUATION_PROVIDER) private readonly llmProvider: LlmEvaluationProvider)`는 데코레이터가 직접 생성 시 영향을 주지 않으므로 가능함을 확인했다). 이 경로는 `invokeProvider`가 provider 종류와 무관하게 모든 에러를 500으로 매핑하는 기존 범용 로직을 그대로 타므로, `evaluation.service.ts`는 수정하지 않았다.
- 이번 라운드에서도 실제 Gemini API를 호출하는 테스트는 추가하지 않았다(전부 로컬 스텁 HTTP 서버). 사용한 합성 키는 기존 `FAKE_API_KEY = 'test-fake-gemini-key-not-a-real-secret'`를 그대로 재사용했다(신규 하드코딩 키 없음).

### 7.4 실패 원인 분석

이번 라운드 실행에서 실패한 테스트는 없다. 다만 테스트 설계 시 주의가 필요했던 지점을 기록한다(전부 설계 단계에서 해소, 프로덕션 코드 결함 아님):

- L-10 "본문 자체가 JSON이 아님" 테스트를 작성할 때, 기존 "AC-5 유사: JSON 파싱 실패 시 명확한 에러로 실패한다" 테스트와 에러 메시지가 겹치지 않도록 주의했다. 두 테스트 모두 `/파싱/`이라는 느슨한 정규식으로 검증하면 서로 구분되지 않으므로, 이번에 추가한 테스트는 더 구체적인 문자열("Gemini 응답 본문 JSON 파싱에 실패했습니다")로 단언해 두 코드 경로(외부 응답 본문 파싱 vs. candidate 내부 text 필드 파싱)를 명확히 구분했다.
- L-10 204 테스트에서 `response.text()`가 본문 없는 204 Response에 대해 빈 문자열을 정상 반환하는지가 관건이었다(Node 내장 fetch/undici의 `Body.text()` 스펙 동작에 의존). 실제로 실행해 확인한 결과 정상적으로 빈 문자열을 반환해 의도한 "candidate가 없습니다" 경로를 그대로 탄다.

### 7.5 커버리지가 부족한 영역 (참고, 이번 라운드에서 미조치)

- §5(이전 라운드 기록)의 항목들은 이번 라운드 범위 밖으로 그대로 유지된다(AC-1 실 API e2e, `gemini-prompt.ts` 전용 단위 테스트 부재, L-2 itemId 중복, 컨트롤러 포함 HTTP e2e 테스트).
- 이번 라운드에서 추가한 L-10 통합 테스트(`EvaluationService` 직접 생성)는 `invokeProvider`의 범용 500 매핑 로직을 처음으로 자동화 테스트에 태웠다는 부수 효과가 있다 — 다만 이는 gemini 특정 시나리오(204 케이스)로만 검증됐고, "provider가 임의의 일반 `Error`를 던지면 500으로 매핑된다"는 완전히 provider-무관한 범용 테스트는 여전히 `evaluation.service.spec.ts`에 없다(이번 라운드는 gemini 관련 회귀만 요청받았으므로 추가하지 않았다 — 필요 시 후속 라운드에서 `evaluation.service.spec.ts`에 mock provider 기반의 범용 테스트를 추가하는 것을 권고한다).
