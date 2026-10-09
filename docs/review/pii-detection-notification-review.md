# PII 마스킹 알림(piiDetected/piiMatches) 코드 리뷰

- 리뷰 일자: 2026-09-18
- 리뷰 대상: 현재 uncommitted 변경사항(`git diff` + untracked 신규 파일), base commit `24292c8`
- 리뷰어: code-reviewer (읽기 전용 — 코드 미수정)
- 판정: **수정 필요** (Critical 1건, High 1건, Medium 3건 선행 조치 후 재검토)

## 1. 검토 범위

### 1.1 Modified

| 파일 | 변경 요지 |
| --- | --- |
| `apps/api/prisma/schema.prisma` | `Evaluation`에 `piiDetected`/`piiMatches` 컬럼 추가 |
| `apps/api/src/evaluation/evaluation.service.ts` | `AggregatedEvaluation`에 PII 필드 매핑 |
| `apps/api/src/evaluation/evaluation.service.spec.ts` | `piiCheck` 계약 위반 케이스 3건 추가 |
| `apps/api/src/evaluation/llm/llm-evaluation-provider.interface.ts` | `LlmPiiMatch`/`LlmPiiCheck` 타입 추가 |
| `apps/api/src/evaluation/llm/schema-builder.ts` | JSON Schema/zod 스키마에 `piiCheck` 추가 |
| `apps/api/src/evaluation/llm/mock-llm-evaluation.provider.ts` | `detectPii()` 로컬 산출 |
| `apps/api/src/evaluation/llm/gemini-llm-evaluation.provider.ts` | `detectPii()` 로컬 산출 |
| `apps/api/src/evaluation/llm/anthropic-llm-evaluation.provider.ts` | 스텁 주석 갱신 |
| `apps/api/src/transcripts/transcripts.service.ts` | 저장/조회 경로에 PII 필드 연결 |
| `apps/web/src/pages/TranscriptResultPage.tsx` | `PiiBadge` 배치 |
| `apps/web/src/styles/global.css` | `.pii-*` 스타일 81줄 추가 |
| `packages/pii-mask/src/mask.ts` | `PII_PLACEHOLDERS` export 화 |
| `packages/pii-mask/src/profanity.ts` | 공통 유틸 분리 + `maskProfanityInSentence` export |
| `packages/shared-types/src/index.ts` | `PiiMatch` 타입 및 응답 DTO 필드 추가 |

### 1.2 Untracked (신규)

| 파일 | 역할 |
| --- | --- |
| `apps/api/prisma/migrations/20260913233527_add_pii_check/` | SQLite 테이블 재생성 마이그레이션 |
| `packages/pii-mask/src/pii-detection.ts` | `detectPii()` 구현 |
| `packages/pii-mask/src/pii-detection.spec.ts` | 단위 테스트 14건 |
| `packages/pii-mask/src/transcript-utils.ts` | 화자 파싱/문장 분리 공통 유틸 |
| `apps/web/src/components/PiiBadge.tsx` | PII 배지 UI |
| `docs/chat-logs/`, `standalone/` | 기능 범위 외 산출물 — C-1 참조 |

### 1.3 빌드/린트/테스트 확인

| 명령 | 결과 |
| --- | --- |
| `pnpm -r build` | 통과 (api/web/packages 전체) |
| `pnpm lint` | 통과 (error 0, warning 11 — 전부 기존 warning) |
| `pnpm --filter @auto-qa/api test` | 통과 (8 suites / 125 tests) |
| `pnpm --filter @auto-qa/pii-mask test` | 통과 (3 suites / 168 tests) |

## 2. 요청 항목별 확인 결과

| 확인 요청 항목 | 결과 | 근거 |
| --- | --- | --- |
| piiMatches의 원문 PII 노출 여부 | 조건부 적합 | 마스킹 5종은 placeholder만 포함. 5종 외 PII는 M-3 참조 |
| DB 저장 JSON의 원문 포함 여부 | 적합 | `detectPii(maskedTranscript)` 결과만 직렬화, 원문 경로 없음 |
| 기존 profanity 패턴과의 일관성 | 대체로 적합 | 구조/네이밍/상한/문장 단위 동일, 레거시 기본값 처리만 상이(H-1) |
| LLM 구조화 출력 계약 훼손 여부 | 문제 있음 | JSON Schema와 실제 산출 주체가 불일치(M-1) |
| 세 프로바이더 간 일관성 | 부분 적합 | mock/gemini는 로컬 산출로 일치, anthropic은 스텁 주석만 갱신 |
| PiiBadge의 UI 패턴/컨벤션 준수 | 적합 | ProfanityBadge와 동일 구조/접근성 속성, CSS 변수 사용 |
| 테스트 커버리지 | 부분 적합 | 탐지 로직 테스트는 충실, 누락 항목은 L-8 참조 |
| 배점 무결성(총점 서버 재계산) | 적합 | 본 변경은 채점 경로 미접촉, `aggregateFromScoredItems` 로직 불변 |
| 로그 내 PII/비밀키 노출 | 적합 | EvaluationService/Gemini 프로바이더 로그에 문장 미포함 |

## 3. 발견 사항

### C-1 (Critical) 실사용 Gemini API 키가 untracked 파일에 평문 포함

- 위치: `docs/chat-logs/auto-qa-claude-chat-log.html`(2.0MB, untracked), `.gitignore`
- 내용: `.env`에 저장된 것과 동일한 `AIzaSy…` 형태의 Google API 키 문자열이 이 HTML 안에 3회 등장한다(동일 문자열이 `.env`에도 존재함을 확인). `.gitignore`에는 `docs/chat-logs/`와 `standalone/` 모두 등록되어 있지 않다.
- 영향: 다음 단계인 git-manager가 `git add .` 또는 `git add docs`를 수행하면 실 API 키, 2MB 대화 로그, 사내 `sLLM 채점 API 명세서.pdf`(`standalone/`)가 그대로 커밋·푸시된다. CLAUDE.md의 "API 키는 커밋/로그에 평문으로 남기지 않는다" 및 "사내 원본 자료는 버전관리 제외" 규정 위반이다.
- 권고: (1) `.gitignore`에 `docs/chat-logs/`, `standalone/` 즉시 추가, (2) 해당 키는 노출된 것으로 간주하고 폐기 후 재발급, (3) 커밋 직전 `git status`로 두 경로가 스테이징 후보에서 사라졌는지 재확인.
- 비고: 본 기능 diff와 무관하지만 커밋 게이트를 통과시키면 안 되는 사안이므로 Critical로 기록한다.

### H-1 (High) 마이그레이션 이전 레코드가 "개인정보 미탐지"(녹색)로 오표시된다

- 위치: `apps/api/prisma/migrations/20260913233527_add_pii_check/migration.sql`, `apps/api/src/transcripts/transcripts.service.ts:151`, `apps/web/src/components/PiiBadge.tsx:34-43`
- 내용: `piiDetected BOOLEAN NOT NULL DEFAULT false`로 기존 행을 백필하므로, 실제로는 PII가 마스킹된 과거 평가도 조회 시 `piiDetected=false`가 되어 UI가 단정적으로 녹색 "개인정보 미탐지"를 표시한다.
- 재현/영향: 마이그레이션 이전 생성된 결과를 조회하면 하단 `EvaluationMetaFooter`는 `maskingSummary` 기준으로 "PII 마스킹: 전화번호 2건"을 표시하는데 상단 배지는 "개인정보 미탐지"로 표시되어, 한 화면에서 상반된 컴플라이언스 정보가 동시에 노출된다.
- 기존 패턴과의 불일치: Phase 3 `maskingSummary`는 레거시 레코드를 `null` → "정보 없음"으로 구분 표시하도록 이미 결정되어 있다(`transcripts.service.ts:125-129`, `EvaluationMetaFooter.formatMaskingSummary`). PII 배지에만 "정보 없음" 상태가 없다.
- 권고(택1): (a) `piiDetected`를 nullable로 두고 `null`일 때 배지를 "정보 없음"으로 렌더링, (b) 조회 시점에 `transcript.maskedText`로부터 `detectPii()`를 파생 계산(레거시 소급 정확 표시 + L-5 중복 저장 동시 해소).

### M-1 (Medium) `buildEvaluationResponseJsonSchema`가 `piiCheck`를 LLM 필수 출력으로 요구 — 설계 주석과 모순

- 위치: `apps/api/src/evaluation/llm/schema-builder.ts:87-107`(신규 `piiCheck` 블록), 같은 파일의 `required: ['items', 'coaching', 'profanityCheck', 'piiCheck']`
- 내용: 인터페이스 주석(`llm-evaluation-provider.interface.ts:59`)과 Gemini 구현 주석은 "piiCheck는 LLM에 요청하지 않고 로컬 `detectPii()`로 산출한다"고 명시하는데, Anthropic 프로바이더가 사용하기로 되어 있는 범용 JSON Schema에는 `piiCheck.matches[].maskedText`가 LLM 생성 필드로 추가되었다. Gemini 스키마는 제외를 테스트로 고정했지만(`gemini-schema-builder.spec.ts`) 범용 스키마만 반대 방향이다.
- 영향: 향후 Anthropic 프로바이더가 이 스키마를 그대로 사용하면 `piiMatches`가 "로컬에서 탐지한 실제 문장"이 아니라 "모델이 생성한 문자열"이 된다. 모델이 그럴듯한 번호를 환각해 넣어도 zod는 `maskedText: z.string()`만 검사하므로 그대로 DB에 저장되고 "감지된 개인정보 포함 문장"이라는 제목으로 화면에 표시된다. 프로바이더별로 `piiDetected`가 달라져 골든 코퍼스 결정론성도 깨진다.
- 권고: 범용 JSON Schema에서 `piiCheck`(가능하면 `profanityCheck`도)를 제거해 "세 프로바이더 모두 로컬 산출"로 계약을 통일하거나, M-2처럼 서비스 계층에서 재산출해 덮어쓴다.

### M-2 (Medium) `EvaluationService`가 프로바이더의 `piiCheck`를 검증 없이 신뢰한다

- 위치: `apps/api/src/evaluation/evaluation.service.ts:119-120`
- 내용: 총점·등급은 "LLM 값을 신뢰하지 않고 서버가 항상 재계산"(NFR-5.1, 같은 파일 63행 주석)하는 원칙을 지키는 반면, `piiDetected`/`piiMatches`는 `response.piiCheck`를 그대로 복사한다. 검증은 zod 형태 검사(`detected=true`면 `matches` 1건 이상)뿐이고, 내용이 실제 `maskedTranscript`에서 유래했는지는 확인하지 않는다.
- 영향: M-1과 결합되면 LLM 환각 문자열이 그대로 저장·노출된다. 반대로 프로바이더가 `detected:false`를 반환하면 실제 PII가 마스킹된 대화도 "미탐지"로 저장된다(프로바이더 버그가 무방비로 전파).
- 권고: `evaluateAndAggregate` 안에서 `detectPii(maskedTranscript)`를 직접 호출해 프로바이더 값을 덮어쓴다. `maskedTranscript`가 이미 인자로 들어와 있어 2~3줄이면 되고, M-1과 프로바이더 3종 일관성이 구조적으로 함께 해소된다.

### M-3 (Medium) 마스킹 대상 5종 외 개인정보가 "개인정보 포함 문장" 패널에 원문 그대로 노출된다

- 위치: `packages/pii-mask/src/pii-detection.ts:50-61`, `apps/web/src/components/PiiBadge.tsx:64-75`
- 내용: `detectPii`는 placeholder가 포함된 문장 전체를 반환한다. `maskPii`의 적용 범위는 RRN/전화/카드/계좌/이메일 5종뿐이므로, 같은 문장 안의 이름·주소·생년월일·고객번호 등은 마스킹되지 않은 채 함께 반환된다.
- 재현: `고객: 저는 홍길동이고 서울시 강남구 테헤란로 123에 살며 번호는 010-1234-5678입니다.` → 패널에 `저는 홍길동이고 서울시 강남구 테헤란로 123에 살며 번호는 [전화번호]입니다.`가 "감지된 개인정보 포함 문장" 제목 아래 표시되고, 동일 문자열이 `evaluations.piiMatches`에 영구 저장된다.
- 평가: 저장 자체는 `transcripts.maskedText`에 동일 문장이 이미 보관되므로 신규 저장 노출면은 아니다. 다만 UI 노출면은 신규이며, 기능 특성상 "잔존 PII 밀도가 가장 높은 문장"만 골라 보여주게 된다.
- 권고: PM 정책 판단 사항. 최소한 패널 안내 문구(`PiiBadge.tsx:72-74`의 "원문은 노출되지 않습니다")를 NFR-1.3 고지(`PiiNoticeCallout`) 수준으로 보정할 것을 권한다. 현재 문구는 "이 문장에는 어떤 개인정보도 남아 있지 않다"는 오해를 준다(예: "자동 마스킹 대상(전화번호·이메일·주민등록번호·카드번호·계좌번호)의 원문은 노출되지 않습니다").

### L-1 (Low) `PiiBadge`가 placeholder 목록을 하드코딩해 `PII_PLACEHOLDERS`와 드리프트한다

- 위치: `apps/web/src/components/PiiBadge.tsx:17`
- 내용: 백엔드는 문자열 리터럴 중복을 피하려 `PII_PLACEHOLDERS`를 export까지 했는데(`mask.ts:56-64`), 프론트엔드는 `(주민등록번호|전화번호|카드번호|계좌번호|이메일)` 정규식으로 다시 하드코딩했다. `PiiKind`가 추가되면 탐지는 되지만 강조 표시만 누락된다.
- 권고: placeholder 상수를 `packages/shared-types`에 두고 FE/BE가 공유한다(`apps/web`은 `@auto-qa/pii-mask`를 의존하지 않으므로 shared-types 경유가 적절).

### L-2 (Low) 한 줄에 여러 화자가 섞인 트랜스크립트에서 화자가 오귀속된다

- 위치: `packages/pii-mask/src/transcript-utils.ts:22-40`
- 내용: `parseSpeakerLines`는 줄 단위로만 화자를 판정하므로, `상담사: … 고객: 제 번호는 [전화번호]입니다.`가 한 줄이면 고객 발화까지 `agent`로 기록된다(`gemini-llm-evaluation.provider.spec.ts` 신규 테스트 주석도 이 동작을 명시적으로 고정한다).
- 영향: 비속어 배지에서는 기존 동작이지만, PII에서는 "상담사가 개인정보를 발설했다"로 오독될 수 있어 QA 판단에 영향을 준다.
- 권고: 동작 변경은 불필요. 화면 문구 또는 요구사항 문서에 "화자 표기는 줄 단위 파싱 기준"임을 알려진 제약으로 기록한다.

### L-3 (Low) `PiiBadge`/`.pii-*` CSS가 `ProfanityBadge`/`.profanity-*`의 거의 완전한 복제다

- 위치: `apps/web/src/components/PiiBadge.tsx` 전체, `apps/web/src/styles/global.css` 신규 81줄
- 내용: 마크업·구조·안내 문구가 동일하고 색상 변수(`--danger` → `--amber`)와 라벨만 다르다. CSS 11개 규칙이 값까지 중복된다.
- 권고: 배지 컴포넌트를 `variant` prop으로 일반화하거나 CSS를 공통 클래스 + 색상 modifier로 정리한다. 지금 필수는 아니나 세 번째 배지가 생기기 전에 정리를 권한다.

### L-4 (Low) `mask.ts`의 별칭 상수 잔재

- 위치: `packages/pii-mask/src/mask.ts:65` — `const PLACEHOLDERS = PII_PLACEHOLDERS;`
- 내용: export 이름 변경 후 기존 참조를 유지하기 위한 별칭이다. 파일 내 참조를 `PII_PLACEHOLDERS`로 일괄 치환하면 제거할 수 있다.

### L-5 (Low) `piiMatches`는 `transcripts.maskedText`에서 파생 가능한 중복 저장이다

- 위치: `apps/api/src/transcripts/transcripts.service.ts:82-83`
- 내용: 결정론적 순수 함수의 결과를 비정규화 저장한다(`profanityMatches` 선례와 동일). 탐지 규칙이 개선되어도 과거 행은 옛 결과를 유지하며 소급 재계산 경로가 없다.
- 권고: H-1의 (b)안을 택하면 자연히 해소된다. 현행 유지 시 "저장 시점 규칙 기준"임을 문서화한다.

### L-6 (Low) 사용자가 placeholder 문자열을 직접 입력하면 오탐한다

- 위치: `packages/pii-mask/src/pii-detection.ts:33-37`
- 내용: 트랜스크립트에 `[전화번호]`라고 타이핑되어 있으면 `maskPii`의 `counts`는 0인데 `piiDetected`는 true가 된다. 하단은 "PII 마스킹: 해당 없음", 상단 배지는 "개인정보 탐지됨"으로 서로 모순된다.
- 영향: 실사용 빈도는 낮다. 필요 시 `counts` 합계와 교차 검증하거나 알려진 한계로 기록한다.

### L-7 (Low) 결과 페이지 레이아웃을 인라인 스타일로 처리했다

- 위치: `apps/web/src/pages/TranscriptResultPage.tsx:130-133`
- 내용: `display: flex` 래퍼를 인라인 `style`로 추가했다. 이 프로젝트는 레이아웃을 `global.css` 클래스로 관리하는 편이므로 전용 클래스가 더 일관적이다(기존 배지 내부에도 인라인 스타일이 있어 치명적 불일치는 아니다).

### L-8 (Low) 테스트 커버리지 갭

- `schema-builder.ts` 전용 spec이 없어 `buildEvaluationResponseJsonSchema`의 `piiCheck` 추가는 직접 검증되지 않는다(zod 경로만 `evaluation.service.spec.ts`로 간접 검증). M-1 수정 시 함께 추가를 권한다.
- `PiiBadge`에 대한 프론트엔드 테스트가 없다(기존 `ProfanityBadge`도 동일하므로 우선순위는 낮다).
- H-1의 레거시 기본값 경로(백필된 `piiDetected=false` 레코드 조회) 테스트가 없다.
- `detectPii` 결과에 마스킹되지 않은 원문 번호(예: `010-1234-5678`)가 포함되지 않는다는 네거티브 테스트가 없다. PII 비노출 계약을 회귀 고정하는 데 유용하다.

## 4. 잘 되어 있는 점

- `transcript-utils.ts`로 화자 파싱/문장 분리를 추출해 `profanity.ts`와 로직을 공유했다. 복붙 대신 공통화를 택했고 기존 동작(주석에 기록된 L-1/L-2/L-3 결정 포함)을 보존했다.
- `PII_PLACEHOLDERS`를 export해 백엔드 측 문자열 리터럴 드리프트를 차단했다(FE만 L-1로 남음).
- PII 문장 안의 비속어를 `maskProfanityInSentence`로 함께 마스킹해 두 배지 간 노출 정책이 어긋나지 않게 했다.
- `MAX_PII_MATCHES = 500` 상한, 1MB 단일 라인, 공백/빈 문자열, 결정론성까지 경계 테스트가 갖춰져 있다.
- Gemini 프로바이더가 모델이 보낸 `piiCheck`를 무시하고 로컬 산출값으로 덮어쓰는 동작을 테스트로 고정했다.
- 마이그레이션 SQL이 기존 데이터를 보존하고 유니크 인덱스를 재생성한다.
- 로그 경로(`EvaluationService`, `GeminiLlmEvaluationProvider`)에 트랜스크립트/문장 스니펫이 추가되지 않았다.

## 5. 종합 의견

기능 구현 품질 자체는 양호하다. 기존 비속어 탐지 패턴을 충실히 따랐고, "placeholder만 노출" 원칙도 마스킹 대상 5종에 대해서는 지켜지며, 빌드·린트·테스트가 모두 통과한다.

다만 아래 조치 전에는 **다음 단계(커밋) 진행 불가**로 판정한다.

| 순서 | 항목 | 담당 | 비고 |
| --- | --- | --- | --- |
| 1 | C-1 키 노출 차단·재발급 | PM | 커밋 전 필수, 기능 diff와 무관 |
| 2 | H-1 레거시 레코드 표시 | backend + frontend | (b)안 채택 시 L-5도 동시 해소 |
| 3 | M-1 / M-2 계약 일원화 | backend-implementer | 서버 측 `detectPii` 재산출로 동시 해결 가능 |
| 4 | M-3 안내 문구 보정 | PM 판단 후 frontend | 정책 수용 시 문구만 조정 |
| 5 | L-1 ~ L-8 | 각 implementer | 경량 수정, 즉시 처리 가능 |

재작업 완료 후 C/H/M 항목 위주로 재검토를 권한다.
