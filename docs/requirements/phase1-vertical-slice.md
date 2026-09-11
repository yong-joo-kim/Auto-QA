# Phase 1 — Vertical Slice (통신 도메인, Mock LLM) 요구사항

- 관련 문서: `CLAUDE.md`, `docs/architecture/eval-sheet-schema.md`, `seed/eval-sheets/03-telecom.json`
- 작성 기준: 통신(telecom) 평가시트(`seed/eval-sheets/03-telecom.json`, 5개 카테고리·14개 항목·100점·게이팅 2항목)
- 산출물 소비자: `ui-designer`, `backend-implementer`, `frontend-implementer`

## 1. 배경 / 목적

Auto QA는 상담대화 Text를 도메인별 평가시트 기준으로 LLM에 채점을 의뢰하고, 결과를 Web에 표시하는 시스템이다. 아직 실제 LLM API 키(Anthropic/Gemini)가 없으므로, Phase 1의 목적은 **"입력 → 마스킹 → 채점(Mock) → 집계/게이팅 판정 → 저장 → 화면 표시"의 end-to-end 파이프라인을 통신 도메인 1건으로 완성**하는 것이다. 이 파이프라인이 동작해야:

- 채점 집계 로직(카테고리 소계/총점/등급/게이팅 판정)을 실제 LLM 응답 없이 검증할 수 있고,
- `LlmEvaluationProvider` 추상화가 올바른지(추후 `anthropic`/`gemini`로 무중단 전환 가능한지) 조기에 검증할 수 있으며,
- UI/DB 스키마를 실제 평가시트 구조(게이팅 포함)에 맞춰 먼저 굳힐 수 있다.

Phase 1은 통신 도메인 1개, Mock LLM 1개 프로바이더로 범위를 좁힌 "수직 슬라이스"이며, 이후 Phase에서 다중 도메인·실제 LLM·PII 마스킹 고도화로 확장한다(`CLAUDE.md` §단계별 전개).

## 2. 사용자 시나리오 (QA 관리자 관점)

**주 시나리오 — 정상 채점**
1. QA 관리자가 Web 화면(`/transcripts/new` 또는 동등 경로)에서 상담대화 트랜스크립트 텍스트를 붙여넣는다.
2. 도메인은 Phase 1에서 "통신(telecom)"으로 고정 표시된다(선택 UI는 있으나 다른 도메인은 비활성/미지원으로 표시 가능).
3. 제출 버튼을 누르면 서버가 트랜스크립트를 PII 마스킹 후 Mock LLM에 채점을 의뢰하고, 진행 중 상태(로딩/스피너 등)가 화면에 표시된다.
4. 채점이 완료되면 결과 화면(`/transcripts/:id`)으로 이동하거나 같은 화면에 결과가 렌더링된다:
   - 카테고리별 소계(기본응대/상담태도/상담전문성/처리효율/컴플라이언스)
   - 항목별 배점(maxScore)/획득점수(score)/사유(reason)
   - 게이팅 결과("통과" / "탈락(재검토 필요)") — 총점과 시각적으로 분리되어 눈에 띄게 표시
   - 총점(totalScore) 및 등급(gradeCriteria 기준)

**예외 시나리오**
- 빈 트랜스크립트로 제출 → 제출 자체가 막히고 인라인 검증 메시지가 표시된다(서버 호출 없음, 또는 서버가 400으로 거부).
- Mock LLM(또는 향후 실제 LLM) 호출이 실패/타임아웃 → 에러 메시지와 재시도 옵션이 표시되고, 부분 결과는 저장되지 않는다.
- 게이팅 항목이 하나라도 F 판정 → 총점이 통과 기준(예: 90점)을 넘더라도 최종 결과는 "탈락(재검토 필요)"로 표시된다.

## 3. 기능 요구사항 (FR)

**FR-1. 트랜스크립트 입력**
- FR-1.1 QA 관리자는 상담대화 원문 텍스트를 자유 텍스트(textarea)로 입력할 수 있다.
- FR-1.2 최소 길이(예: 공백 제외 10자 이상) 미만이거나 빈 문자열이면 제출을 막고 검증 메시지를 표시한다.
- FR-1.3 ~~도메인 선택 필드를 제공하되, Phase 1은 `telecom`만 선택 가능~~ **(2026-09-12부로 FR-11로 대체됨 — 10개 도메인 전부 선택 가능)**. 자동 분류(키워드 매칭 등)는 이번 Phase 범위에서 제외한다(§6 Out of scope, FR-11.2).

**FR-2. PII 마스킹**
- FR-2.1 서버는 트랜스크립트를 Mock LLM에 전달하거나 DB에 저장하기 **전에** 반드시 PII 마스킹을 수행한다.
- FR-2.2 Phase 1 마스킹 대상(정규식 기반 최소 구현, `packages/pii-mask`):
  - 휴대전화번호(010-xxxx-xxxx, 01xxxxxxxxx 등 하이픈 유무 패턴)
  - 이메일 주소
  - 주민등록번호 형식(######-#######, 6자리-7자리)
  - 카드번호(4자리×4 또는 4자리-4자리-4자리-4자리)
  - 계좌번호는 Phase 1에서는 Best-effort(자릿수 패턴 기반)로 처리하고, 완전한 정확도는 요구하지 않는다(Phase 3에서 고도화).
- FR-2.3 마스킹된 자리는 항목 종류를 알 수 있는 placeholder로 치환한다(예: `[전화번호]`, `[이메일]`, `[주민등록번호]`, `[카드번호]`). 마스킹 로직/치환 형식의 세부 사양은 `packages/pii-mask` 구현 시 확정하되, **원문 그대로 노출되는 치환(단순 별표 개수 불일치 등으로 원문 유추 가능한 방식)은 금지**한다.
- FR-2.4 마스킹 실패/미탐지가 있을 수 있음을 인지하고, 이번 Phase는 "정규식 기반 최소 구현"으로 명시하며 100% 탐지를 보장하지 않는다(비기능 요구사항 §5 참고).

**FR-3. 도메인 평가시트 로딩**
- FR-3.1 서버는 `seed/eval-sheets/03-telecom.json`(또는 `packages/eval-schema`를 통해 로드된 동일 구조의 telecom 평가시트)을 채점 기준으로 사용한다.
- FR-3.2 평가시트 구조는 `docs/architecture/eval-sheet-schema.md`의 스키마(카테고리/항목/maxScore/gating/gradeCriteria/gatingPolicy)를 그대로 따른다. 하드코딩된 별도 채점 기준을 만들지 않는다.

**FR-4. LLM 채점 요청 (Provider 추상화)**
- FR-4.1 서버는 `LlmEvaluationProvider` 인터페이스를 통해 채점을 요청한다. Phase 1 기본 구현체는 `mock`이며, env `LLM_PROVIDER=mock`(기본값)로 선택된다.
- FR-4.2 요청 시 평가시트의 모든 카테고리·항목이 빠짐없이 포함되어야 하며, 응답은 항목별로 1:1 대응해야 한다(누락 항목이 있으면 에러로 처리).
- FR-4.3 Mock 어댑터의 동작 규칙은 §4.3(Mock LLM 상세 규칙) 참조.

**FR-5. 채점 결과 집계**
- FR-5.1 카테고리 소계(categoryScore) = 해당 카테고리 내 항목 score 합.
- FR-5.2 총점(totalScore) = 전체 카테고리 소계 합(= 전체 항목 score 합). `totalMaxScore`(=100)와 별도로 검증하지는 않되, 항목별 `score`가 `maxScore`를 초과하면 서버는 이를 유효성 오류로 처리한다(§5 비기능 요구사항).
- FR-5.3 게이팅 판정: `gating: true`인 항목 중 하나라도 `passFail: "F"`이면 `gatingResult = "탈락(재검토 필요)"`, 그렇지 않으면 `gatingResult = "통과"`.
- FR-5.4 등급 산정: `totalScore`를 평가시트의 `gradeCriteria`(90/80/70/0 구간)에 대입하여 산출한다. 게이팅 탈락 여부와 무관하게 등급 자체는 계산·표시하되(참고용), 최종 결과 해석은 게이팅이 우선한다는 점을 UI 문구로 명시한다(예: "게이팅 탈락 시 등급과 무관하게 재검토 필요").

**FR-6. 결과 저장**
- FR-6.1 제출된 트랜스크립트는 **마스킹된 텍스트만** DB에 저장한다(원문 미저장 원칙, §5).
- FR-6.2 채점 결과(항목별 score/reason/passFail, 카테고리 소계, 총점, 등급, 게이팅 결과, 사용된 평가시트 버전·도메인, 사용된 LLM provider 식별자, 생성 시각)를 함께 저장한다.
- FR-6.3 저장된 레코드는 고유 ID를 가지며, 결과 화면은 이 ID로 재조회 가능해야 한다(`/transcripts/:id` 등).

**FR-7. 결과 화면 표시**
- FR-7.1 카테고리별 소계, 항목별 배점/획득점수/사유를 표 또는 카드 형태로 표시한다.
- FR-7.2 게이팅 결과를 총점/등급과 시각적으로 구분되게(예: 별도 배너/배지, 탈락 시 경고색) 표시한다.
- FR-7.3 총점과 등급을 표시한다.
- FR-7.4 진행 중(채점 요청 ~ 응답 수신) 상태를 로딩 인디케이터로 표시한다.
- FR-7.5 에러 발생 시 사용자에게 이해 가능한 에러 메시지와 재시도 동작을 제공한다.

**FR-8. 욕설·비속어 탐지 (2026-09-12 추가 — UI 시안 검토 후 반영)**
- FR-8.1 Mock LLM 채점 응답에는 전체 트랜스크립트에 대한 욕설·비속어 탐지 결과가 포함된다: 탐지 여부(boolean)와, 탐지된 경우 발화자(고객/상담사)·마스킹된 문장 목록.
- FR-8.2 결과 화면에는 탐지 여부를 초록(미탐지)/빨강(탐지됨) 아이콘 배지로 표시한다.
- FR-8.3 빨강 상태일 때 배지를 클릭하면 탐지된 문장 목록이 펼쳐진다(마스킹된 형태로 표시, 원문 비속어는 노출하지 않음 — NFR-1 원문 비저장 원칙과 동일하게 비속어도 마스킹 후 저장/표시).
- FR-8.4 탐지된 비속어 문장은 트랜스크립트 마스킹(FR-2)과 동일한 파이프라인에서 함께 처리되어도 되며, 별도 필드(`profanityDetected`, `profanityMatches`)로 저장한다.

**FR-9. AI 코칭 요약 (2026-09-12 추가)**
- FR-9.1 Mock LLM 채점 응답에는 항목별 사유와 별개로, 전체 상담에 대한 정성적 코칭 요약이 포함된다: "칭찬할 점"(goodPoints, 1~3개 문장)과 "보완할 점"(improvements, 1~3개 문장).
- FR-9.2 결과 화면 상단(총점/등급 요약 아래)에 두 목록을 나란히 표시한다.
- FR-9.3 코칭 문구는 템플릿 기반으로 생성하되(§4.3 Mock 규칙과 동일하게 결정론적), 상담사에게 직접 전달 가능한 어조(구어체 코칭 톤)로 작성한다.

**FR-10. 점수 수동 보정(Override) 기능 (2026-09-12 추가 → 2026-09-12 기능 확정으로 범위 변경)**
- FR-10.1 결과 화면의 항목별 점수 옆에 편집 아이콘을 표시하며, 클릭 시 QA 관리자가 해당 항목의 점수를 0~maxScore 범위 내에서 직접 수정할 수 있다.
- FR-10.2 보정 시 보정 사유(메모, 선택 또는 필수는 프론트 재량)를 함께 입력받을 수 있다.
- FR-10.3 저장 시 서버는 해당 항목의 score를 갱신하고, **카테고리 소계/총점/등급/게이팅 결과를 서버에서 전부 재계산**한다(NFR-5.1과 동일 원칙 — 클라이언트가 총점을 직접 지정하지 않는다). gating 항목의 점수를 보정해도 `passFail` 값 자체는 QA 관리자가 별도로 P/F를 함께 지정하지 않는 한 자동 변경하지 않는다(점수와 게이팅 판정은 별개 필드).
- FR-10.4 보정된 항목은 AI 원 점수와 구분되게 표시한다(예: 취소선 처리된 AI 원점수 + 보정된 점수 + "관리자 보정" 배지 + 보정 메모, 보정자/시각).
- FR-10.5 보정 이력은 최소 1건(최신 보정) 이상 저장하며, 다건 이력 관리(누가 언제 무엇을 바꿨는지 전체 로그)는 Out of scope로 유지한다(§7).
- FR-10.6 인증/계정 시스템이 없는 Phase 1에서는 "평가자"를 자유 텍스트 입력(또는 고정값)으로 받는다(§7 인증 Out of scope와 일관).

**FR-11. 다중 도메인 지원 (2026-09-12 추가 → 2026-09-12 범위 확장)**
- FR-11.1 도메인 선택 UI에서 10개 도메인(`seed/eval-sheets/01~10-*.json`) 전부를 선택 가능하게 한다. 이전의 "telecom 고정, 나머지 비활성" 제약(FR-1.3)을 해제한다.
- FR-11.2 자동 분류(트랜스크립트 내용 기반 도메인 추론)는 여전히 Out of scope다 — 사용자가 화면에서 직접 도메인을 선택한다.
- FR-11.3 서버는 선택된 `domainId`에 대응하는 평가시트를 `seed/eval-sheets/`에서 로드하여 채점 기준으로 사용한다. 도메인별 카테고리 구성은 공통(기본응대/상담태도/상담전문성/처리효율/컴플라이언스)이나 항목 수·배점·게이팅 항목은 도메인마다 다를 수 있으므로(§3 FR-3.2), UI는 항목 개수를 하드코딩하지 않고 응답 데이터 기준으로 렌더링해야 한다.
- FR-11.4 지원하지 않는 `domainId`(오타, 존재하지 않는 도메인)는 여전히 400으로 거부한다.

## 4. 데이터 요구사항

### 4.1 트랜스크립트 입력 스키마 (Client → Server)

```jsonc
// POST /transcripts (요청)
{
  "domainId": "telecom",        // Phase 1: "telecom" 고정
  "rawText": "string",          // 공백 제외 최소 10자 이상, 필수
  "metadata": {                  // 선택, Phase 1은 선택 필드로만 취급(채점 로직에 영향 없음)
    "agentId": "string?",
    "consultedAt": "ISO8601 string?",
    "channel": "voice|chat?"
  }
}
```

- 서버는 `rawText`를 마스킹한 `maskedText`만 이후 단계(LLM 요청, DB 저장)에서 사용한다. `rawText`는 요청 처리 중 메모리에만 존재하며 어떤 스토리지에도 영속화하지 않는다(로그 포함 금지, §5.2).

### 4.2 Mock LLM 요청/응답 스키마 (Server ↔ LlmEvaluationProvider)

요청(내부 인터페이스 계약, 실제 anthropic/gemini 구현체도 동일 형태를 받는다):

```jsonc
{
  "domainId": "telecom",
  "maskedTranscript": "string",
  "evalSheet": { /* seed/eval-sheets/03-telecom.json 과 동일 구조 전체 */ }
}
```

응답(구조화 출력, 세 프로바이더 공통 계약 — `docs/architecture/eval-sheet-schema.md` §3/§4 변경사항 반영):

```jsonc
{
  "items": [
    {
      "itemId": "basic-response-01",
      "score": 4,                 // 0 <= score <= maxScore(해당 itemId)
      "reason": "string"          // 채점 근거(한국어 서술)
      // gating: false 항목은 passFail 필드 없음
    },
    {
      "itemId": "compliance-01",
      "score": 8,
      "reason": "string",
      "passFail": "P"             // gating: true 항목만 필수: "P" | "F"
    }
    // ... evalSheet의 모든 itemId에 대해 1건씩, 누락 불가
  ],
  "providerMeta": {
    "provider": "mock",
    "model": "mock-v1",           // anthropic/gemini 전환 시 실제 모델명으로 대체
    "latencyMs": 1234
  },
  "coaching": {                   // FR-9
    "goodPoints": ["string", "..."],   // 1~3개
    "improvements": ["string", "..."]  // 1~3개
  },
  "profanityCheck": {             // FR-8
    "detected": true,
    "matches": [
      { "speaker": "customer|agent", "maskedText": "string" }  // 마스킹된 문장만, 원문 비노출
    ]
  }
}
```

### 4.3 Mock LLM 어댑터 동작 규칙 (`LLM_PROVIDER=mock`)

목적: 실제 LLM 없이도 채점 로직·집계·게이팅 판정·UI를 의미 있게 검증할 수 있어야 한다. 아래 규칙은 구현 시 반드시 지켜야 하는 계약이다.

1. **결정론적 의사난수(seeded)**: 각 항목의 점수는 `hash(maskedTranscript + itemId)`를 시드로 하는 의사난수 생성기(PRNG)로 산출한다. 동일 트랜스크립트 + 동일 평가시트 버전이면 항상 동일한 채점 결과가 나와야 한다(재현성 확보, 스냅샷 테스트 가능).
2. **점수 범위 엄수**: 모든 항목의 `score`는 `0 <= score <= item.maxScore` 정수(또는 정해진 단위)여야 한다. Mock 어댑터가 이 범위를 벗어난 값을 내는 것은 버그이며 허용되지 않는다.
3. **점수 분포**: 일반 항목(gating 아님)은 "양호한 상담원"을 시뮬레이션하기 위해 `maxScore`의 60~100% 구간에 편향된 분포를 기본으로 하되, 일정 확률(예: 15~20%)로 40~60% 구간의 낮은 점수도 생성하여 감점 케이스를 재현한다.
4. **게이팅 항목 처리**: `gating: true`인 항목은 `passFail`을 별도로 결정한다.
   - 낮은 확률(예: 8~12%, 시드 기반)로 `passFail: "F"`를 발생시켜 탈락 케이스를 재현 가능하게 한다.
   - `passFail: "F"`인 경우 해당 항목의 `score`는 낮은 구간(예: 0~30% of maxScore)으로 강제하여 사유와 점수가 서사적으로 일관되게 한다.
   - `passFail: "P"`인 경우 일반 항목과 동일한 분포 규칙을 따른다.
5. **사유(reason) 생성**: 점수 구간(우수/양호/보통/미흡 등)에 대응하는 템플릿 문장에 항목명을 채워 한국어 사유를 생성한다(예: "표준 인사말에 따라 소속과 이름을 명확히 안내함 — 기준 충족"). LLM이 실제로 생성한 것처럼 보이되, 고정 템플릿 기반임을 코드 주석/테스트로 명시한다.
6. **지연 시뮬레이션**: 요청당 인위적 지연(예: 500ms~2000ms, 항목 수에 비례 또는 고정 범위)을 두어 UI의 진행 상태(FR-7.4) 표시를 실사용처럼 검증 가능하게 한다.
7. **오류 주입(테스트 전용)**: 환경변수(예: `MOCK_LLM_FAILURE_RATE`, 기본값 0)로 실패율을 설정할 수 있어야 하며, 이 값이 0보다 크면 해당 확률로 에러(타임아웃/5xx 등)를 발생시켜 §3 FR-7.5, §6 AC의 에러 처리 경로를 자동 테스트로 검증할 수 있게 한다. 기본 운영/데모 환경에서는 0으로 두어 항상 성공한다.
8. **`evalSheet`의 모든 항목에 대해 응답을 생성**해야 하며, 항목 누락·중복·존재하지 않는 `itemId` 응답은 허용하지 않는다.
9. Mock 어댑터는 실제 LLM Provider(`anthropic`, `gemini`)와 **동일한 인터페이스 시그니처**(요청/응답 타입)를 구현해야 하며, 호출부(집계 로직, API 컨트롤러)는 어떤 프로바이더가 붙어 있는지 몰라도 동작해야 한다(`LLM_PROVIDER` 전환 시 코드 변경 없이 동작).
10. **욕설·비속어 탐지(FR-8)**: 마스킹된 트랜스크립트에서 사전 정의된 비속어/금칙어 패턴(간단한 키워드 목록으로 최소 구현, 예: `packages/pii-mask` 또는 별도 `packages`에 목록 보관)을 정규식으로 탐지한다. 탐지되면 `profanityCheck.detected=true`와 함께 해당 문장을 화자 구분하여 마스킹된 형태로 반환한다(원문 비속어 단어 자체는 응답에도 포함하지 않고 `****` 등으로 치환). 탐지 여부는 시드 기반이 아니라 실제 텍스트 매칭 결과를 따른다(재현성은 자동 보장됨 — 같은 텍스트는 같은 매칭 결과).
11. **AI 코칭 요약(FR-9)**: 채점된 항목 점수 분포(예: 최고점 카테고리 → "칭찬할 점" 템플릿, 최저점/게이팅 실패 항목 → "보완할 점" 템플릿)를 기반으로 결정론적으로 1~3개 문장씩 생성한다. §5의 사유(reason) 생성과 동일하게 템플릿 기반임을 코드 주석/테스트로 명시한다.

### 4.4 저장 스키마 개요 (DB)

```jsonc
// Transcript
{
  "id": "uuid",
  "domainId": "telecom",
  "maskedText": "string",       // 마스킹된 텍스트만 저장. rawText는 저장하지 않음.
  "metadata": { /* FR-1 참고, optional */ },
  "createdAt": "ISO8601"
}

// Evaluation
{
  "id": "uuid",
  "transcriptId": "uuid",       // FK -> Transcript.id
  "domainId": "telecom",
  "evalSheetVersion": "1.0.0",  // seed/eval-sheets/03-telecom.json 의 version
  "llmProvider": "mock",
  "llmModel": "mock-v1",
  "items": [
    { "itemId": "string", "categoryId": "string", "score": 0, "maxScore": 0, "reason": "string", "passFail": "P|F|null" }
  ],
  "categoryScores": [
    { "categoryId": "string", "score": 0, "maxScore": 0 }
  ],
  "totalScore": 0,
  "totalMaxScore": 100,
  "grade": "우수|양호|보통|미흡",
  "gatingResult": "통과|탈락(재검토 필요)",
  "goodPoints": ["string"],       // FR-9
  "improvements": ["string"],     // FR-9
  "profanityDetected": false,     // FR-8
  "profanityMatches": [           // FR-8, profanityDetected=false면 빈 배열
    { "speaker": "customer|agent", "maskedText": "string" }
  ],
  "createdAt": "ISO8601"
}
```

- `rawText`(원문)는 어떤 테이블/필드에도 저장하지 않는다. 이는 요구사항이자 DB 스키마 설계 제약이다(`backend-implementer`는 Prisma 스키마에 원문 저장 컬럼을 두어서는 안 됨).

### 4.5 점수 수동 보정(Override) API (FR-10, 2026-09-12 추가)

```jsonc
// PATCH /evaluations/:id/items/:itemId (요청)
{
  "score": 5,              // 0 <= score <= item.maxScore, 정수
  "note": "string?",       // 보정 사유(선택)
  "reviewer": "string?"    // 평가자 식별(자유 텍스트, 인증 없음 — FR-10.6)
}

// 응답: EvaluationResultResponse 전체(§4.4 구조 + override 필드), 재계산된 totalScore/categoryScores/grade/gatingResult 포함
```

- `Evaluation.items[]`에 override 관련 필드 추가: `originalScore: number | null`(최초 AI 점수, 보정 시에만 값 존재), `overridden: boolean`, `overrideNote: string | null`, `overrideReviewer: string | null`, `overriddenAt: ISO8601 | null`.
- 존재하지 않는 `id`/`itemId` → 404. `score`가 범위를 벗어나면 → 400.

## 5. 비기능 요구사항 (NFR)

**NFR-1. PII / 보안**
- NFR-1.1 원문 트랜스크립트는 요청 처리 파이프라인 내 메모리에서만 존재하고, 마스킹 이후에만 LLM 호출·DB 저장·로그에 사용될 수 있다. 원문을 파일/DB/로그 어디에도 영속화하지 않는다(Phase 1 최우선 정책, `CLAUDE.md` §컨벤션과 일치).
- NFR-1.2 서버 로그(access log, error log 포함)에 `rawText`를 기록하지 않는다. 에러 로그에 트랜스크립트 내용을 남겨야 하는 경우에도 `maskedText`만 사용한다.
- NFR-1.3 Phase 1의 마스킹은 정규식 기반 최소 구현이며 완전한 PII 탐지를 보장하지 않는다는 한계를 문서화한다(Phase 3에서 고도화 예정, `CLAUDE.md` §단계별 전개). 이 한계는 QA 관리자에게도 UI 문구(예: 안내 툴팁)로 짧게 고지하는 것을 권장한다(필수는 아님, `ui-designer` 재량).
- NFR-1.4 API 키(`ANTHROPIC_API_KEY` 등)는 `.env`로만 관리하며 Mock 구현체는 어떤 외부 키도 요구하지 않는다.

**NFR-2. LLM Provider 스위치**
- NFR-2.1 `LlmEvaluationProvider` 인터페이스를 정의하고, `mock`/`anthropic`/`gemini` 구현체가 모두 동일한 요청/응답 타입(§4.2)을 사용해야 한다.
- NFR-2.2 프로바이더 선택은 오직 env `LLM_PROVIDER`(기본값 `mock`)로 결정되며, 애플리케이션 코드(컨트롤러/집계 로직) 변경 없이 값만 바꿔 전환 가능해야 한다. Phase 1에서는 `mock`만 실제로 구현하고, `anthropic`/`gemini`는 인터페이스 자리만 확보(스텁 또는 미구현 시 명확한 에러)해도 무방하다.
- NFR-2.3 향후 실제 프로바이더 추가 시 기존 집계/게이팅/저장 로직을 변경할 필요가 없어야 한다(추상화 검증이 이번 Phase의 핵심 목적 중 하나).

**NFR-3. 에러 처리**
- NFR-3.1 빈/과도하게 짧은 트랜스크립트 → 400 계열 응답 + 프론트 인라인 검증 메시지.
- NFR-3.2 LLM(Mock) 호출 실패/타임아웃 → 500/504 계열 응답, 트랜스크립트/평가 레코드는 저장하지 않거나(원자적 처리) 실패 상태로 표시되고, 프론트는 사용자에게 실패 사실과 재시도 버튼을 제공한다.
- NFR-3.3 LLM 응답이 계약(§4.2)을 위반하는 경우, 위반 유형에 따라 다르게 처리한다(2026-09-12, backend-implementer 구현 시 확정):
  - **구조적 위반**(항목 누락/중복, 존재하지 않는 `itemId` 등 — 안전하게 복구 불가능) → 502류 에러로 처리하고 저장하지 않는다.
  - **값 범위 위반**(`score`가 `maxScore` 초과, 필수 `passFail` 누락 등 — 개별 필드 단위 문제) → 최대 1회 재시도 후에도 위반이 지속되면, 값을 안전 범위로 clamp하고 `Evaluation.status = "manual_review"`로 저장하여 QA 관리자가 사후 확인할 수 있게 한다(`CLAUDE.md`의 backend-implementer 지침과 일치).
- NFR-3.4 존재하지 않는 `transcriptId`로 결과 조회 시 404.

**NFR-4. 성능**
- NFR-4.1 Mock 프로바이더 기준, 제출~결과 표시까지 체감 지연은 수 초 이내(§4.3의 인위적 지연 500ms~2000ms 범위 포함)여야 하며, 이후 실제 LLM 연동 시 지연이 더 길어질 것을 감안해 로딩 상태(FR-7.4)는 처음부터 필수로 구현한다.

**NFR-5. 데이터 일관성**
- NFR-5.1 집계된 `totalScore`, `categoryScores`, `gatingResult`, `grade`는 항상 저장된 `items`로부터 서버에서 재계산되며, 클라이언트가 이 값을 직접 지정/조작할 수 없다.

## 6. 수용기준 (Acceptance Criteria)

**AC-1. 정상 채점 흐름**
- Given QA 관리자가 결과 입력 화면에 있고, 유효한 통신 도메인 샘플 트랜스크립트(10자 이상)를 입력했을 때
- When 제출 버튼을 클릭하면
- Then 진행 상태 표시 후, 카테고리별 소계 5건(기본응대/상담태도/상담전문성/처리효율/컴플라이언스), 항목별 배점/획득점수/사유 14건(통신 기준 — 도메인마다 항목 수는 다를 수 있음, §FR-11 참고), 게이팅 결과(통과 또는 탈락), 총점, 등급이 화면에 표시된다.

**AC-2. 빈 입력 검증**
- Given 트랜스크립트 입력란이 비어 있을 때
- When 제출을 시도하면
- Then 서버 호출 없이(또는 서버가 400을 반환하여) 인라인 검증 메시지가 표시되고 결과 화면으로 이동하지 않는다.

**AC-3. 게이팅 탈락 표시**
- Given Mock LLM 응답에서 게이팅 항목(`compliance-01` 또는 `compliance-04`) 중 하나 이상이 `passFail: "F"`로 판정되었을 때(§4.3-4의 확률적 시나리오 또는 테스트용 고정 시드)
- When 결과 화면이 렌더링되면
- Then 총점/등급과 무관하게 "탈락(재검토 필요)"가 총점과 분리되어 눈에 띄게(예: 경고 배지) 표시된다.

**AC-4. 게이팅 통과 + 등급 계산**
- Given 모든 게이팅 항목이 `passFail: "P"`이고 총점이 92점으로 집계되었을 때
- When 결과 화면이 렌더링되면
- Then 게이팅 결과는 "통과", 등급은 "우수"(90점 이상 기준)로 표시된다.

**AC-5. LLM(Mock) 오류 처리**
- Given `MOCK_LLM_FAILURE_RATE`가 1(항상 실패)로 설정된 테스트 환경에서
- When 트랜스크립트를 제출하면
- Then 사용자에게 오류 메시지와 재시도 옵션이 표시되고, 해당 시도에 대한 트랜스크립트/평가 레코드는 저장되지 않는다(또는 실패 상태로만 저장되고 정상 결과처럼 조회되지 않는다).

**AC-6. 원문 비저장**
- Given 특정 트랜스크립트를 제출하여 저장이 완료되었을 때
- When DB(`Transcript` 테이블 등)를 직접 조회하면
- Then 마스킹된 텍스트만 존재하고, 원문 그대로의 전화번호/이메일/주민등록번호/카드번호 패턴이 포함된 원문 텍스트는 어디에도 존재하지 않는다.

**AC-7. PII 마스킹 동작**
- Given 트랜스크립트 원문에 전화번호(`010-1234-5678`), 이메일(`test@example.com`)이 포함되어 있을 때
- When 제출하면
- Then 저장된 `maskedText`와 Mock LLM에 전달된 텍스트 모두에서 해당 값이 `[전화번호]`, `[이메일]` 등 placeholder로 치환되어 있다.

**AC-8. 재현성(결정론적 Mock)**
- Given 동일한 트랜스크립트(마스킹 결과 동일)를 두 번 제출했을 때
- When 각각 채점 결과를 비교하면
- Then 항목별 score/reason/passFail이 완전히 동일하다(§4.3-1).

**AC-9. 점수 범위 검증**
- Given Mock 또는 향후 실제 프로바이더의 응답에 `score`가 해당 항목 `maxScore`를 초과하는 값이 포함되었을 때(테스트로 강제 주입)
- When 서버가 응답을 처리하면(1회 재시도 포함)
- Then 값은 안전 범위로 clamp되고 `status: "manual_review"`로 저장되어 QA 관리자가 사후 확인 가능한 상태로 표시된다(§5 NFR-3.3, 2026-09-12 확정). 항목 누락/중복 등 구조적 위반은 여전히 502로 거부되고 저장되지 않는다.

**AC-10. Provider 전환 가능성**
- Given env `LLM_PROVIDER=mock`으로 정상 동작이 검증된 상태에서
- When `LlmEvaluationProvider` 인터페이스를 구현하는 별도 구현체(테스트용 더미 `anthropic` 스텁 등)로 `LLM_PROVIDER` 값만 바꾸면
- Then 컨트롤러/집계/저장/UI 코드 변경 없이 동일한 흐름(§AC-1)이 재사용된다(코드 수정 없이 전환 가능함을 코드 리뷰/테스트로 확인).

**AC-11. 욕설·비속어 탐지 표시 (FR-8)**
- Given Mock LLM 응답의 `profanityCheck.detected`가 `true`일 때
- When 결과 화면이 렌더링되면
- Then 빨강 배지가 표시되고, 클릭 시 마스킹된 탐지 문장 목록이 펼쳐진다. `detected`가 `false`이면 초록 배지만 표시되고 클릭해도 펼쳐질 내용이 없다(또는 배지 자체가 클릭 불가/비활성).

**AC-12. AI 코칭 요약 표시 (FR-9)**
- Given 채점이 정상 완료되었을 때
- When 결과 화면이 렌더링되면
- Then "칭찬할 점"과 "보완할 점"이 각각 1개 이상의 문장으로 표시된다.

## 7. Out of scope (Phase 1 제외 범위)

다음은 이번 Phase 1에서 구현하지 않으며, 명시된 이후 Phase 또는 별도 계획으로 다룬다:

- **실제 LLM 연동**(Anthropic Claude API, Gemini API 실호출) — Phase 4/5 이후, API 키 확보 시.
- **다중 도메인 자동 분류**(트랜스크립트 내용 기반으로 10개 도메인 중 자동 판별) — 여전히 범위 밖. 단, **사용자가 직접 선택**하는 방식의 10개 도메인 지원 자체는 FR-11로 범위에 포함됨(2026-09-12 확장).
- **평가시트 관리 화면**(CRUD, 배점/항목 편집 UI) — 범위 밖. 평가시트는 `seed/eval-sheets/*.json` 정적 로드만 지원.
- **인증/인가**(로그인, 사용자별 권한, QA 관리자 계정 관리) — 범위 밖. Phase 1은 단일 익명 사용자 전제.
- **상담내역 목록/검색/필터 화면**(여러 건의 과거 평가 이력 리스트업) — 단건 제출→단건 결과 조회 흐름만 지원. ID로 직접 조회하는 상세 화면만 필수.
- **점수 수동 수정(Override) 기능** — 2026-09-12부로 FR-10으로 범위에 포함되어 더 이상 Out of scope가 아님. 단, **보정 이력의 다건 로그 관리**(누가 언제 무엇을 바꿨는지 전체 감사이력)는 계속 Out of scope(FR-10.5).
- **음성/STT 연동, 파일 업로드 기반 트랜스크립트 수집** — 텍스트 붙여넣기만 지원.
- **PII 마스킹 고도화**(문맥 기반 NER 등 정규식 이상의 방식) — Phase 3.
- **감사 로그(audit) UI, 통계/리포트 대시보드** — 범위 밖.
- **동시성/배치 처리, 대량 트랜스크립트 일괄 채점** — 단건 처리만 지원.
