# Phase 1 Vertical Slice — 코드 리뷰 (Round 2, 재리뷰)

## 1. 검토 범위

1차 리뷰(`docs/review/phase1-vertical-slice-review.md`) 이후 수정된 파일 + 영향 경로:

- `apps/api/src/evaluation/evaluation.service.ts`
- `apps/api/src/evaluation/llm/schema-builder.ts`
- `packages/eval-schema/src/schema.ts`
- `packages/pii-mask/src/mask.ts`, `packages/pii-mask/src/profanity.ts`
- 회귀 확인용 동반 검토: `apps/api/src/evaluation/llm/mock-llm-evaluation.provider.ts`, `apps/api/src/transcripts/transcripts.service.ts`, `packages/eval-schema/src/loader.ts`, `packages/shared-types/src/index.ts`, `apps/web/src/components/ItemDetailSections.tsx`, `apps/web/src/pages/TranscriptNewPage.tsx`, `seed/eval-sheets/*.json` 10종

**검증 방법**: 정적 리뷰 + 타입체크/빌드 + 컴파일 산출물에 대한 런타임 프로브 4종(계약위반 31케이스, 마스킹 24케이스, 비속어 17케이스, 평가시트 불변식 13케이스, Mock 결정론성/AC-9 경로). 1차 리뷰와 동일한 "결함이 실제로 재현되지 않는가" 기준.

**빌드 결과**

| 명령 | 결과 |
|---|---|
| `pnpm --filter @auto-qa/{shared-types,eval-schema,pii-mask} build` | 통과 (0 error) |
| `pnpm --filter @auto-qa/api exec tsc -p tsconfig.json` | 통과 (0 error) |
| `pnpm --filter @auto-qa/web exec tsc --noEmit` | 통과 (0 error) |
| `pnpm --filter @auto-qa/web exec vite build` | 통과 (188KB / gzip 61KB) |
| `pnpm lint` | 여전히 no-op (M-7, 이번 범위 외) |

## 2. 1차 지적사항 재검증 결과

| 항목 | 판정 | 근거 |
|---|---|---|
| H-1 NaN totalScore | **해소** | 프로브 8종 전부 재현 실패 |
| H-2 coaching/profanityCheck 미검증 | **해소** | 프로브 15종 전부 502 |
| M-1 score 정수 검증 | **해소** | |
| M-2 reason 미검증 | **해소** | |
| M-3 비속어 오탐 | **부분 해소** | 지적된 케이스는 수정, 동종 오탐 잔존 |
| M-4 계좌번호 과탐 | **부분 해소** | 날짜/유선전화 수정, 단문 숫자코드 잔존 |
| M-5 LLM 실패 로깅 | **해소** | |
| M-6 배점 합계 불변식 | **해소** | |
| M-8 검증 상수 중복 | **해소** | |

### H-1 — 해소 (Verified)

`evaluation.service.ts:172`에서 `!Number.isFinite(result.score)`가 범위 검증 단계에 추가되었고, `:199-201`에서 `Number()` → `Number.isFinite` 가드 → `0` 대체 후 clamp합니다.

런타임 프로브 8종(`score` 누락 / `"5"` / `NaN` / `null` / `"abc"` / `Infinity` / `999`(초과) / `-5`) 전부:
- `status="manual_review"`, `totalScore` 유한, 전 항목 정수, `score > maxScore` 항목 0건.
- `NaN`이 DB로 흘러가는 경로 재현 불가.

`score: "5"`(숫자형 문자열)도 재시도 후 `5`로 정상 보정되며 `manual_review`로 표시되어 사후 검토 가능 — 적절합니다.

### H-2 — 해소 (Verified)

`schema-builder.ts:102-161`에 `buildLlmResponseZodSchema`가 신설되고 `evaluation.service.ts:130-135, 145-153`이 이를 호출합니다. 구조/값 범위 관심사 분리(zod = 구조 → 502, `validateScoreRanges` = 값 범위 → 재시도/clamp)가 NFR-3.3과 정확히 일치합니다.

프로브 15종 전부 `BadGatewayException(502)`이며 `TypeError`(500) 재현 불가:

| 케이스 | 결과 |
|---|---|
| `coaching` 누락 / `null` | 502 |
| `profanityCheck` 누락 | 502 |
| `goodPoints: []` (AC-12 위반) | 502 |
| `goodPoints` 4개 / 문자열 / `[""]` | 502 |
| `detected:true` & `matches:[]` | 502 |
| `speaker:"bot"` | 502 |
| `providerMeta` 누락 | 502 |
| items 누락/중복/미지 itemId | 502 |
| `items`가 배열 아님 / 응답 자체가 `null` | 502 |

메시지도 `LLM 응답이 계약을 위반했습니다: coaching.goodPoints: Array must contain at least 1 element(s)` 형태로 진단 가능합니다.

### M-1 / M-2 — 해소 (Verified)

`evaluation.service.ts:174-176`(정수), `:178-180`(reason 공백), `:203-206`(보정 문구). `score: 3.7` → `manual_review`, 정수로 반올림. `reason` 누락/공백/숫자 3케이스 모두 `manual_review` + `"자동 보정됨: LLM 응답에 유효한 사유가 없어 수동 검토가 필요합니다."`로 치환되어 UI `undefined` 노출 경로가 사라졌습니다.

### M-5 — 해소 (Verified)

`evaluation.service.ts:116-127`. 실측 로그:

```
ERROR [EvaluationService] LLM 채점 요청 실패 (provider=Object, errorClass=Error): boom: secret-key-abc
```

`providerName`/`errorClass`/`message`가 남고, 마스킹 텍스트·원문 스니펫은 로그에 포함되지 않음을 확인했습니다(프로브에서 `maskedTranscript`에 전화번호를 넣어 검증). 응답은 `InternalServerErrorException(500)` + 사용자 안전 문구 — NFR-3.2("500/504 계열")와 일치합니다.

### M-6 — 해소 (Verified)

`packages/eval-schema/src/schema.ts:50-73` superRefine.
- seed 10종 전부 정상 로드(`totalMaxScore=100`), 위양성 없음.
- 변조 3종 전부 거부: item 합 불일치 / totalMaxScore 불일치 / category만 증가.

`EvalSheet` 타입은 `evalSheetBaseSchema`에서 추론하도록 분리되어 `ZodEffects`화로 인한 타입 회귀가 없고, 유일 소비처인 `loader.ts:64`가 `evalSheetSchema.parse`를 쓰므로 정상 동작합니다.

### M-8 — 해소 (Verified)

`packages/shared-types/src/index.ts:33`의 `MIN_TRANSCRIPT_NON_WHITESPACE_LENGTH` 단일 정의를 API(`transcripts.service.ts:16,236`)와 Web(`TranscriptNewPage.tsx:4,18`)이 함께 참조합니다. 중복 상수 잔존 없음(전역 grep 확인).

### M-3 — 부분 해소 (Medium 잔존)

`profanity.ts:22-55`의 `falsePositiveSuffixes` + negative lookahead로 지적된 케이스는 해소:

| 입력 | detected |
|---|---|
| `새끼손가락이 아파요` | false ✅ |
| `새끼발가락 다쳤어요` | false ✅ |
| `새끼고양이 분양` | false ✅ |

그러나 **부분 문자열 매칭이라는 원인 자체는 남아 있어 동종 오탐이 재현**됩니다. 특히 통신/IT 도메인에서 현실성이 매우 높은 케이스가 포함됩니다:

| 입력 | detected | 비고 |
|---|---|---|
| `상담사: 화면이 꺼져서요` | **true** | 통신/IT 상담 빈출 표현 → 상담사 비속어로 오판 |
| `상담사: 불이 꺼져 있어요` | **true** | 동일 |
| `고객: 시발점이 어디인가요` | **true** | |
| `고객: 시발택시 타고 갑니다` | **true** | |
| `상담사: 병신년(丙申年) 자료` | **true** | |
| `고객: 강아지 새끼를 키워요` | **true** | 조사 `를` 때문에 lookahead 미적용 |
| `고객: 새끼 줄 좀 주세요` | **true** | 공백 때문에 lookahead 미적용 |

영향: `profanityDetected=true`로 DB 저장 → 결과 화면에 빨강 배지 + "상담사 비속어 검출"이 표시됨. QA 결과의 신뢰도에 직접 영향. Mock 프로바이더가 `detectProfanity`를 그대로 쓰므로(`mock-llm-evaluation.provider.ts:84`) **Phase 1 현재 상태에서 사용자 입력만으로 재현 가능**합니다.

권고: 최소한 `꺼져`를 `꺼져(?![서써]?요?$)` 류가 아니라 단어 목록에서 제외하거나, `씨발/시발`에 `점|택시`, `병신`에 `년\(|년(丙|戊|庚|壬|甲)` 등 접미 예외를 보강. 근본적으로는 접미어 블랙리스트 대신 "조사/어미 허용 + 형태소 경계" 방식이 필요하며, Phase 3 PII/비속어 고도화 과제로 이관 권고.

### M-4 — 부분 해소 (Low 잔존)

`mask.ts:45-50`(유선전화 규칙 선행 배치), `:57-64`(날짜 negative lookahead)로 지적된 3종 중 2종 해소:

| 입력 | 결과 |
|---|---|
| `오늘은 2026-09-11 입니다` | 원문 보존 ✅ |
| `가입일 2024-01-01 ~ 2025-12-31` | 원문 보존 ✅ |
| `유선 032-1234-5678` | `[전화번호]` ✅ (계좌번호 오탐 해소) |
| `유선 02-123-4567` | `[전화번호]` ✅ |
| `주문번호 20260911-0012-77` | 원문 보존 ✅ |
| `상품코드 123-456-789` | **`[계좌번호]`** ❌ |
| `요금 12-34-56 코드` | **`[계좌번호]`** ❌ |
| `고객번호 0212345678901234` | **`[카드번호]`** ❌ |

잔존 과탐은 "PII가 아닌 값이 마스킹되어 LLM 채점 근거가 훼손"되는 방향이며 PII 유출 방향은 아닙니다(fail-safe). 정상 케이스(휴대폰/유선/카드/계좌/이메일, 혼합 문장, 하이픈 없는 형태)는 전부 정상 마스킹되며 **탐지 누락 회귀는 없음**을 확인했습니다. Low로 격하하고 Phase 3 이관 권고.

## 3. 회귀 및 신규 발견 사항

### 회귀 없음 (확인 항목)

- Mock 정상 경로: `status=completed`, `totalScore=78`, 등급 산출 정상.
- **Mock 결정론성 유지**: 동일 트랜스크립트 2회 호출 시 항목 점수 배열 완전 일치.
- **AC-9 경로 정상 동작**: `MOCK_LLM_FORCE_INVALID=1` → 재시도 후에도 초과 → clamp → `status=manual_review`, `totalScore` 유한, `score > maxScore` 항목 0건.
- 재시도 성공 경로: 1차 범위 위반 → 2차 정상 → `status=completed` (불필요한 `manual_review` 승격 없음).
- 비게이팅 항목의 `passFail`은 여전히 `undefined`로 정규화됨.
- `aggregateFromScoredItems` 공유 경로(`TranscriptsService.overrideItemScore`)의 자체 검증(`transcripts.service.ts:176-185`: 타입/정수/0~maxScore)은 그대로 유지.
- 평가시트 seed 10종 로딩 위양성 없음. FE/BE 빌드 전부 통과.

### N-1 (Medium, 신규) — LLM 응답이 override 감사 필드를 위조할 수 있음

- `apps/api/src/evaluation/llm/schema-builder.ts:109` — `z.object({ itemId: z.string() }).passthrough()`
- `apps/api/src/evaluation/evaluation.service.ts:268-272` — `originalScore`/`overridden`/`overrideNote`/`overrideReviewer`/`overriddenAt`를 응답에서 그대로 수용

재현(프로브 실측): 프로바이더가 item에 `overridden:true, originalScore:999, overrideReviewer:"LLM이 위조한 관리자", overriddenAt:"2020-01-01..."`를 실어 보내면 그대로 통과해 DB에 저장되고, `apps/web/src/components/ItemDetailSections.tsx:160-196`이 이를 "QA 관리자가 보정함 / 최초 AI 점수 999점"으로 렌더링합니다. `originalScore=999`는 `maxScore`를 초과한 값인데도 표시됩니다.

동일 계약의 JSON Schema(`schema-builder.ts:32-36`)는 `additionalProperties: false`인데 런타임 zod만 `passthrough()`라 두 계약이 불일치합니다. Phase 1의 mock은 이 필드를 내보내지 않아 현재 노출은 없으나, Phase 4 실제 LLM 연동 시 환각 응답으로 **감사 추적(FR-10) 무결성이 깨질 수 있습니다.**

권고: item 스키마를 `.strict()`로 바꾸거나(`itemId`/`score`/`reason`/`passFail`만 허용), 최소한 `aggregateFromScoredItems`가 LLM 최초 집계 경로에서는 override 관련 필드를 무시하도록 분리.

### N-2 (Low, 신규) — 값 범위 위반 사유가 서버 로그에 전혀 남지 않음

`evaluation.service.ts:85-99` — `rangeErrors` / `retryRangeErrors`가 계산만 되고 로깅 없이 버려집니다. M-5로 "호출 실패"의 관측성은 확보됐지만, 운영에서 `manual_review`가 쌓였을 때 **어느 항목이 왜 clamp됐는지 추적할 방법이 없습니다.** `this.logger.warn(...)` 1줄 추가 권고(원문/마스킹 텍스트 미포함, itemId·사유만).

### N-3 (Low, 신규) — 빌드 산출물에 1차 리뷰 프로브 잔재

`apps/api/dist/__verify-contract.{js,d.ts,js.map}`가 남아 있습니다. `apps/api/src`에 원본이 없는 stale 산출물(1차 리뷰 프로브 흔적)이므로 코드 결함은 아니나, `dist/`가 `.gitignore`에 포함되어 있는지 확인 후 정리 권고.

### 미해결 (이번 범위 외)

M-7(ESLint 미구성 — 루트 `package.json:13`의 `lint`가 여전히 위양성 통과), L-1~L-14는 PM 지시에 따라 재검증하지 않았습니다.

## 4. 종합 의견

**판정: 통과 (Pass) — test-automation 단계 진행 가능**

1차 리뷰가 **머지 차단으로 지정한 5개 항목(H-1, H-2, M-1, M-2, M-5)은 전부 해소**되었으며, "코드가 존재한다"가 아니라 31종 계약위반 런타임 프로브로 **의도한 결함이 재현되지 않음**을 실측 확인했습니다. 권고 항목 중 M-6, M-8도 완전 해소됐습니다. 수정 과정에서 Mock 결정론성·AC-9 clamp 경로·PII 탐지율·FE/BE 빌드에 회귀는 발견되지 않았습니다.

다만 아래 3건을 **비차단 후속 과제**로 등록해 주시기 바랍니다.

### 후속 과제 (머지 차단 아님)

| 우선순위 | 항목 | 담당 | 파일:라인 |
|---|---|---|---|
| 1 | **N-1** LLM 응답의 override 감사 필드 위조 차단 (`passthrough` → `strict` 또는 필드 무시) | backend-implementer | `apps/api/src/evaluation/llm/schema-builder.ts:109`, `apps/api/src/evaluation/evaluation.service.ts:268-272` |
| 2 | **M-3** 비속어 오탐 잔존 — 최소 `꺼져` 제외 + `시발점/시발택시/병신년` 예외 보강 (근본 해결은 Phase 3) | backend-implementer | `packages/pii-mask/src/profanity.ts:33-46` |
| 3 | **N-2** 값 범위 위반 사유 warn 로깅 추가 | backend-implementer | `apps/api/src/evaluation/evaluation.service.ts:85-99` |
| 4 | **M-4** 단문 숫자코드 계좌번호 과탐 (Low, Phase 3 이관) | backend-implementer | `packages/pii-mask/src/mask.ts:57-64` |
| 5 | **N-3** stale `dist/__verify-contract.*` 정리 | deployment-engineer | `apps/api/dist/` |

### test-automation 인계 사항

아래 프로브 시나리오를 회귀 테스트로 고정해 주시기 바랍니다(이번 재리뷰에서 실측한 케이스 그대로):
- 계약위반 → 502: coaching/profanityCheck 누락·null, `goodPoints:[]`/4개/`[""]`, `detected:true & matches:[]`, `speaker` enum 위반, providerMeta 누락, items 누락/중복/미지 itemId, items 비배열, 응답 null (15종)
- 값 범위 위반 → `manual_review` + `Number.isFinite(totalScore)` + 전 항목 정수 + `score <= maxScore`: score 누락/`"5"`/NaN/null/`"abc"`/Infinity/초과/음수, 소수, reason 누락/공백/숫자, gating passFail 누락 (13종)
- 재시도 1회 후 성공 시 `status="completed"` 유지
- 평가시트 불변식: seed 10종 통과 + 변조 3종 거부
- Mock 결정론성(단, `latencyMs`는 비결정론 — L-7)

### 핵심 파일 경로

- `apps/api/src/evaluation/evaluation.service.ts`
- `apps/api/src/evaluation/llm/schema-builder.ts`
- `packages/eval-schema/src/schema.ts`
- `packages/pii-mask/src/mask.ts`
- `packages/pii-mask/src/profanity.ts`
- `apps/web/src/components/ItemDetailSections.tsx`
