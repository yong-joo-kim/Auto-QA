# 코드 리뷰: 평가시트 Excel 업로드/다운로드 + 사용자 수정 기준 적용

- 검토일: 2026-10-09
- 검토자: code-reviewer (읽기 전용)
- 요구/설계 문서: `docs/requirements/eval-sheet-upload-download.md`

## 1. 검토 범위

미커밋 작업트리 중 이 기능으로 추가/변경된 파일만 대상으로 했다. PII 탐지 등 다른 기능의 변경은 제외했다.

| 구분     | 파일                                                                 |
|----------|----------------------------------------------------------------------|
| 패키지   | `packages/eval-schema/src/loader.ts` (override 저장/로드)            |
| API      | `apps/api/src/eval-sheets/eval-sheet-xlsx.ts`                        |
| API      | `apps/api/src/eval-sheets/eval-sheets.service.ts`                    |
| API      | `apps/api/src/eval-sheets/eval-sheets.controller.ts`                 |
| API      | `apps/api/src/eval-sheets/eval-sheets.module.ts`                     |
| 테스트   | `apps/api/src/eval-sheets/eval-sheet-xlsx.spec.ts`                   |
| Web      | `apps/web/src/pages/EvalSheetsPage.tsx`                              |
| Web      | `apps/web/src/api/client.ts` (하단 eval-sheets 관련)                 |
| Web      | `apps/web/src/components/TopBar.tsx`, `App.tsx`, `styles/global.css` |
| 설정     | `.gitignore` (`/data/`), `apps/api/package.json` (exceljs, multer)   |

연관 경로로 함께 확인한 파일은 `apps/api/src/transcripts/transcripts.service.ts`(toResponse, overrideItemScore), `apps/api/src/evaluation/evaluation.service.ts`(aggregateFromScoredItems), `apps/api/src/main.ts`(CORS), `packages/eval-schema/src/schema.ts`이다.

## 2. 빌드/린트/테스트 확인

| 항목                                   | 결과                      |
|----------------------------------------|---------------------------|
| `tsc --noEmit` (eval-schema)           | 통과                      |
| `tsc --noEmit` (api)                   | 통과                      |
| `tsc --noEmit` (web)                   | 통과                      |
| `eslint` (대상 파일)                   | 통과                      |
| `jest src/eval-sheets src/transcripts` | 통과 (3 suites, 31 tests) |

## 3. Auto QA 특화 관점 요약

| 관점            | 결과                                                                                  |
|-----------------|---------------------------------------------------------------------------------------|
| PII 처리        | 이상 없음. 평가시트에는 트랜스크립트가 들어가지 않고, 업로드 내용을 로그로 남기지 않음 |
| 배점 무결성     | 이슈 있음 (H-2). 시트 변경 뒤 기존 결과를 보정하면 score > maxScore 가능               |
| API 키/비밀정보 | 이상 없음                                                                             |
| 에러 처리       | 이슈 있음 (M-6, M-7, L-7, L-8)                                                        |
| 업로드 보안     | 이슈 있음 (H-1, M-1, M-5)                                                             |
| 경로 조작       | 실제 경로 조작은 불가능함(화이트리스트 + 고정 .json 접미사). 방어 코드 보강만 권고 (L-1) |

## 4. 발견 사항

### H-1 (High) 작은 xlsx 하나로 API 프로세스 메모리 고갈(DoS)

- 위치: `apps/api/src/eval-sheets/eval-sheet-xlsx.ts:105-114`, `:191-198`
- 문제: 항목 루프와 메타 문구 루프가 `ws.rowCount`까지 `ws.getRow(r)`를 호출한다. ExcelJS의 `getRow`는 행이 없으면 Row 객체를 새로 만들어 워크시트에 유지한다. 행 수는 셀 하나만 멀리 떨어진 행(예: 1,048,000행)에 두면 압축 파일 크기와 상관없이 커진다. 게다가 항목 루프는 항목이 하나도 없으면 빈 행에서 `continue`하므로, 헤더만 두고 그 아래를 비우면 끝까지 돈다.
- 실측: 헤더 + A1048000 셀 하나만 있는 탭 1개(파일 크기 6,453바이트)에서 루프 1회에 약 630ms, 힙 약 573MB가 늘었다. 이 기능은 두 루프(항목 + 메타)를 돌기 때문에 탭당 약 1GB가 든다. `1_`~`10_` 탭 10개를 넣으면 약 10GB가 필요해 Node 기본 힙 한도를 넘고 프로세스가 크래시한다. 5MB 크기 제한으로는 막을 수 없다.
- 재현: 무인증 상태에서 `POST /eval-sheets/upload`로 위 구조의 파일을 1회 업로드한다. API가 OOM으로 종료되고 채점 서비스 전체가 중단된다.
- 수정 제안:
  - 행 순회 상한을 둔다(예: `Math.min(ws.actualRowCount, headerRow + 300)`. 도메인당 배점 합계 100, 항목 최소 1점이므로 항목은 최대 100행이다).
  - 메타 루프는 헤더 위쪽(1~headerRow)과 `합계` 행 이후 몇 행만 검사한다.
  - `getRow` 대신 `ws.eachRow({ includeEmpty: false })`나 `ws.findRow(r)`처럼 행을 새로 만들지 않는 API를 쓴다.
  - 워크시트 수 상한(예: 20개)도 둔다.

### H-2 (High) 시트를 수정한 뒤 기존 채점 결과를 점수 보정하면 배점 무결성이 깨지고 과거 결과가 새 기준으로 덮어써짐

- 위치: `apps/api/src/transcripts/transcripts.service.ts:190-217`, `apps/api/src/evaluation/evaluation.service.ts:256-298`
- 문제: `overrideItemScore`는 score 범위를 **저장 당시** `target.maxScore`로 검증한다. 그런데 재계산은 `getEvalSheetOrThrow(evaluation.domainId)`, 즉 **현재(override) 시트**로 하고, `aggregateFromScoredItems`는 itemName/criteria/maxScore/gating을 현재 시트 값으로 다시 써서 DB에 저장한다. 요구사항의 "이미 저장된 채점 결과는 저장 당시의 항목/버전을 유지한다"와 정면으로 충돌한다.
- 재현 시나리오:
  1. 통신 시트 v1.0.0으로 채점한다(`basic-response-01` 만점 5, 5점 획득).
  2. 업로드로 `basic-response-01` 배점을 4로, 다른 항목을 6으로 바꾼다(v1.0.1).
  3. 1번 결과에 `basic-response-01` 점수 보정(score 5)을 요청한다. 검증은 저장된 maxScore 5 기준이라 통과하고, 재계산된 항목은 `score: 5, maxScore: 4`가 되어 DB에 저장된다. 항목 점수가 만점을 넘는다.
  4. 항목을 추가하거나 이름을 바꾸면(새 itemId 발급) `aggregateFromScoredItems`가 `BadGatewayException`(502)을 던진다. 그 도메인의 과거 결과는 모두 보정할 수 없게 된다.
  5. 항목을 삭제하면 재계산 결과에서 그 항목이 조용히 빠지고 totalScore/grade가 바뀐다. `evalSheetVersion`은 옛 값 그대로라 이력 추적도 틀어진다.
  6. 비게이팅 항목을 게이팅으로 바꾸면 `passFail`이 undefined가 되고 게이팅 판정이 의미를 잃는다.
- 수정 제안:
  - 채점 시점의 시트 스냅샷을 저장한다(Evaluation에 `evalSheetSnapshot` JSON 컬럼을 두거나, `data/eval-sheets-history/<domainId>/<version>.json`처럼 버전별 파일을 남기고 버전으로 조회한다). 보정 재계산은 그 스냅샷으로 한다.
  - 최소한의 단기 조치로는, 저장된 `items`의 maxScore/gating/categoryId만으로 재집계하는 경로를 쓴다. `evalSheetVersion`이 현재 version과 다르면 현재 시트를 사용하지 않는다.
  - 회귀 테스트를 추가한다: 시트 변경 후 과거 결과 보정에서 score <= maxScore 유지, 502 미발생, 항목 수 유지.

### M-1 (Medium) zip 압축 해제 크기 상한 없음(zip bomb)

- 위치: `apps/api/src/eval-sheets/eval-sheet-xlsx.ts:242-244`, `apps/api/src/eval-sheets/eval-sheets.controller.ts:41`
- 문제: multer 5MB 제한은 압축된 크기에만 적용된다. `wb.xlsx.load`는 JSZip으로 모든 파트(sharedStrings, sheetN.xml, 임의로 추가한 파트 포함)를 메모리에 전부 풀어 파싱한다. 고압축 XML(같은 문자열 반복)이면 수백 MB~GB까지 커질 수 있다.
- 재현: 5MB 안쪽에 압축률 1000:1 수준의 sharedStrings.xml을 담은 xlsx를 업로드한다. 메모리가 급증하고 이벤트 루프가 장시간 블로킹된다.
- 수정 제안: 로드 전에 JSZip(exceljs 의존성)으로 중앙 디렉터리만 읽고, 각 엔트리의 압축 해제 크기 합계(예: 50MB 이하)와 엔트리 수를 검사한다. 또는 스트리밍 리더(`ExcelJS.stream.xlsx.WorkbookReader`)로 바꾸고 읽은 바이트 수를 제한한다. H-1과 함께 처리하길 권한다.

### M-2 (Medium) 버전 라벨이 콘텐츠를 유일하게 식별하지 못함

- 위치: `apps/api/src/eval-sheets/eval-sheet-xlsx.ts:61-64`, `:219`
- 문제: 버전은 항상 "현재 시트 version + patch 1"이다. 다음 경우 서로 다른 기준이 같은 버전 문자열을 갖게 된다.
  - 업로드(1.0.1) → 기본값 복원(1.0.0) → 다른 내용으로 재업로드하면 다시 1.0.1이 된다.
  - 두 사용자가 같은 1.0.1을 기반으로 동시에 업로드하면 둘 다 1.0.2가 되고, 나중에 쓴 쪽이 이긴다.
- 영향: `Evaluation.evalSheetVersion`만으로는 어떤 기준으로 채점했는지 알 수 없다. H-2의 스냅샷 대책을 버전으로 조회하는 방식으로 구현하면 잘못된 기준을 불러오게 된다.
- 수정 제안: 버전 이력(최대 patch)을 별도로 보관해 단조 증가시키거나, 콘텐츠 해시(예: sha256 앞 8자리)를 함께 저장한다(`1.0.3+a1b2c3d4`). 복원 시에도 이력은 유지한다.

### M-3 (Medium) 여러 차례 업로드하면 삭제된 itemId가 다른 항목에 재사용될 수 있음

- 위치: `apps/api/src/eval-sheets/eval-sheet-xlsx.ts:90-93`, `:169-176`
- 문제: `usedItemIds`는 "현재 시트(base)"의 ID만 담는다. 1차 업로드에서 `basic-response-03`을 삭제하면 2차 업로드의 base에는 그 ID가 없다. 그래서 같은 카테고리에 새 항목을 추가하면 `n = items.length + 1 = 3`이 되어 `basic-response-03`이 의미가 다른 항목에 다시 발급된다. 카테고리 ID(`custom-category-NN`)도 같은 방식으로 재사용될 수 있다.
- 영향: 과거 결과의 `basic-response-03`(옛 항목)과 새 시트의 `basic-response-03`(새 항목)이 같은 ID로 묶인다. H-2의 보정 경로에서는 옛 항목 점수가 새 항목 이름/배점으로 조용히 매핑되고, 항목별 통계도 오염된다.
- 수정 제안: seed ID 전체와 지금까지 발급한 모든 ID(이력 파일 또는 override 파일 안의 `retiredItemIds`)를 `usedItemIds`에 넣는다. 또는 신규 ID에 짧은 랜덤/타임스탬프 접미사를 붙여 재사용을 원천 차단한다.

### M-4 (Medium) override 쓰기가 도메인 간에 원자적이지 않고, 동시 업로드 시 임시 파일이 충돌함

- 위치: `packages/eval-schema/src/loader.ts:88-90`, `apps/api/src/eval-sheets/eval-sheets.service.ts:79-89`
- 문제:
  1. all-or-nothing은 검증 단계에만 적용된다. 쓰기 루프에서 3번째 도메인의 `writeFileSync`/`renameSync`가 실패하면(디스크 부족, Windows에서 백신/뷰어가 파일을 잡아 EPERM/EBUSY) 1~2번째 도메인은 이미 반영된 상태로 500이 반환된다. UI는 "반영 실패"로 보이지만 일부만 적용된다.
  2. 임시 파일 이름이 `<domainId>.json.tmp`로 고정이라, 같은 도메인에 동시 요청이 오면 A의 write → B의 write → A의 rename(B 내용) → B의 rename(ENOENT로 500) 순으로 꼬일 수 있다.
  3. 동시 업로드에는 lost update도 생긴다(M-2와 연동). 쓰기 실패 시 `.tmp` 파일 정리도 없다.
- 수정 제안:
  - `importWorkbook` 전체를 프로세스 내 뮤텍스(Promise 체인)로 직렬화한다. 단일 인스턴스 전제를 문서에 적는다.
  - 임시 파일명에 고유값(pid + randomUUID)을 붙이고, 실패 시 `finally`에서 정리한다.
  - 모든 도메인의 tmp를 먼저 쓴 뒤 rename한다. 중간에 실패하면 이미 rename한 도메인을 이전 내용으로 롤백한다(백업 보관). 또는 디렉터리 단위로 세대를 바꾸는 방식(포인터 파일)을 검토한다.

### M-5 (Medium) 무인증 + `enableCors()` 와일드카드라 브라우저 경유 CSRF로 채점 기준을 바꿀 수 있음

- 위치: `apps/api/src/main.ts:8`, `apps/api/src/eval-sheets/eval-sheets.controller.ts:39-56`
- 문제: 인증이 없다는 점은 요구사항 문서에 명시되어 있다. 그런데 `multipart/form-data` POST는 CORS 단순 요청이라 프리플라이트 없이 전송된다. 따라서 사내 사용자가 악성 외부 페이지를 열기만 해도, 그 페이지가 사내 API로 조작된 평가시트를 업로드할 수 있다. 또 `enableCors()` 기본값이 모든 출처 허용이라 DELETE(복원)와 응답 읽기도 임의 출처에서 가능하다. 이후 모든 채점 기준이 공격자 의도대로 바뀐다(예: criteria에 프롬프트 인젝션 문구 삽입).
- 수정 제안:
  - CORS origin을 env(예: `WEB_ORIGIN`) 화이트리스트로 제한한다.
  - 상태를 바꾸는 엔드포인트(upload/delete)에 커스텀 헤더(예: `X-Requested-With: auto-qa-web`)를 요구해 프리플라이트를 강제하고, Origin 헤더도 검증한다.
  - 사내망 외 노출 전 인증/권한(관리자 역할) 도입을 추적 이슈로 남긴다.

### M-6 (Medium) 손상된 override 파일 하나가 해당 도메인 전체를 오해 소지 있는 오류로 막음

- 위치: `packages/eval-schema/src/loader.ts:67-71`, `apps/api/src/transcripts/transcripts.service.ts:248-253`, `:124`
- 문제: override JSON이 깨지거나(수동 편집, 부분 기록), 스키마가 바뀌어 zod 검증에 실패하면 `loadEvalSheet`가 예외를 던진다. 그 결과 다음 일이 생긴다.
  - 채점 요청은 `getEvalSheetOrThrow`가 예외를 삼켜 "지원하지 않는 domainId입니다"라는 400을 돌려준다. 원인을 오인하게 된다.
  - `GET /eval-sheets`는 10개 도메인 중 하나만 깨져도 목록 전체가 500이 된다. 관리 화면 자체가 열리지 않아 복원 버튼에도 접근할 수 없다.
  - `GET /eval-sheets/download`와 업로드(`loadCurrent`)도 500이 된다.
  - 해당 도메인의 과거 결과 조회(`toResponse`)도 500이 된다.
- 수정 제안: `readOverride`에서 파싱/검증 실패를 별도 에러 타입(예: `EvalSheetOverrideCorruptError`)으로 구분한다. `list()`는 그 도메인을 손상 상태로 표시해 UI에서 복원할 수 있게 한다. 채점 경로는 명확한 메시지와 함께 500/503을 반환한다(seed로 조용히 대체하면 기준이 혼동될 수 있으니 정책을 결정한다). `getEvalSheetOrThrow`는 "미지원 domainId"인 경우에만 400으로 변환한다.

### M-7 (Medium) 무시된 탭(ignoredSheets)을 UI에 표시하지 않아 사용자 수정이 조용히 사라짐

- 위치: `apps/web/src/pages/EvalSheetsPage.tsx:126-131`, `apps/api/src/eval-sheets/eval-sheet-xlsx.ts:255-259`
- 문제: 탭 이름에서 번호 접두를 지우거나(`통신...`), 바꾸거나(`11_...`, `0_...`), 공백/전각 문자를 넣으면 그 탭은 `ignoredSheets`로 분류된다. 서버는 이를 응답에 담지만 UI는 표시하지 않는다. 사용자는 "변경된 평가 기준이 없어 반영할 내용이 없습니다" 또는 다른 도메인만 반영되었다는 메시지만 보게 되어, 자신의 수정이 버려졌다는 사실을 알 수 없다.
- 수정 제안: `ignoredSheets`에서 `00_안내`를 뺀 나머지가 있으면 경고 배너로 탭 이름을 나열한다. 서버에서는 번호 범위 밖(0, 11 이상) 접두 탭을 무시하지 말고 오류로 처리하는 방안도 검토한다.

### M-8 (Medium) 항목명/세부 기준 길이 상한이 없어 LLM 프롬프트가 비대해질 수 있음

- 위치: `apps/api/src/eval-sheets/eval-sheet-xlsx.ts:128-136`, `packages/eval-schema/src/schema.ts:8-14`
- 문제: 셀당 최대 32,767자까지 그대로 받아들인다. 도메인당 최대 100항목이면 프롬프트에 수백만 자가 들어가 Gemini/Anthropic 호출이 토큰 한도 초과로 실패하거나 비용이 급증한다. 해당 도메인의 모든 채점이 실패한다. criteria는 사용자 입력이 그대로 프롬프트에 들어가므로 프롬프트 인젝션 경로이기도 하다(M-5와 결합하면 위험이 커진다).
- 수정 제안: 업로드 검증에 길이 상한을 둔다(예: categoryName/itemName 100자, criteria 1,000자, 메타 문구 500자). 같은 제한을 zod 스키마에도 반영해 override 파일 직접 편집도 막는다.

### L-1 (Low) overridePath의 domainId 검사가 프로토타입 키를 통과시킴

- 위치: `packages/eval-schema/src/loader.ts:60`, `:115`
- 문제: `FILE_BY_DOMAIN[domainId]`는 `constructor`, `toString` 같은 키에 대해 truthy를 반환한다. 현재는 서비스 계층(`resetToDefault`의 `includes`, DTO `@IsIn`)이 먼저 막고 경로 끝에 `.json`이 고정이라 path traversal은 불가능하다. 다만 패키지 함수만 보면 방어가 불완전하다(`loadSeed`에서 `path.join`에 함수가 전달되어 TypeError).
- 수정 제안: `Object.hasOwn(FILE_BY_DOMAIN, domainId)`를 쓰고, 추가로 `^[a-z0-9-]+$` 형식 검사를 한다.

### L-2 (Low) 항목명 중복 검사 범위가 요구사항과 다름 [해결: 코드를 요구사항에 맞춰 시트 전체 범위로 검사]

- 위치: `apps/api/src/eval-sheets/eval-sheet-xlsx.ts:146-151`
- 문제: 요구사항은 "항목명 중복 금지"인데 구현은 "같은 구분 안"에서만 검사한다. 서로 다른 구분에 같은 항목명이 있으면 LLM 사유/결과 화면에서 헷갈린다.
- 수정 제안: 도메인 전체에서 중복을 금지하거나, 구분 단위 정책을 요구사항 문서에 명시한다.

### L-3 (Low) 표 중간의 빈 행이나 합계 아래 행이 경고 없이 무시됨 [해결: 빈 행 아래 항목 발견 시 오류]

- 위치: `apps/api/src/eval-sheets/eval-sheet-xlsx.ts:109-113`
- 문제: 사용자가 보기 좋게 표 중간에 빈 행을 넣으면 그 아래 항목이 모두 잘린다. 보통은 합계 100 검증에 걸리지만, 오류 메시지가 "배점 합계가 N점"이라 원인을 찾기 어렵다. 우연히 합계가 맞으면 조용히 반영된다.
- 수정 제안: 종료 지점 이후 `합계` 행 전까지 비어 있지 않은 행이 있으면 "N행: 빈 행 아래의 항목은 인식되지 않습니다" 오류를 추가한다.

### L-4 (Low) cellText의 줄바꿈 정규화가 셀 타입마다 다름

- 위치: `apps/api/src/eval-sheets/eval-sheet-xlsx.ts:37-43`
- 문제: 일반 문자열 셀은 개행을 공백으로 바꾸지만, richText/formula/hyperlink 셀은 개행을 그대로 둔다. 서식이 일부 들어간 셀(Excel에서 굵게 등)만 개행이 남아 프롬프트/다운로드 결과가 들쭉날쭉해진다. 같은 내용인데 `hasChanged`가 변경으로 판정할 수도 있다.
- 수정 제안: 모든 분기 결과에 같은 정규화(개행 → 공백, trim)를 적용한다.

### L-5 (Low) 과거 결과 조회 시 출처/면책 문구를 현재 시트에서 가져옴

- 위치: `apps/api/src/transcripts/transcripts.service.ts:124`, `:153-154`
- 문제: `toResponse`는 저장된 items/점수를 쓰므로 점수 표시는 안전하다. 다만 `sourceCitation`, `disclaimer`, `domainName`은 현재 시트에서 읽는다. 업로드로 출처 문구를 바꾸면 과거 결과 화면에도 새 문구가 나온다. 또 M-6 상황에서는 조회 자체가 실패한다.
- 수정 제안: H-2의 스냅샷을 도입할 때 함께 스냅샷 기준으로 바꾼다. 시트 로드가 실패해도 조회는 되도록 try/catch로 대체값을 쓴다.

### L-6 (Low) 컨트롤러 파일 타입/확장자 검사 정리

- 위치: `apps/api/src/eval-sheets/eval-sheets.controller.ts:42`, `:46`
- 문제: `@types/multer`를 추가했지만 인라인 타입을 쓴다. 확장자 검사는 latin1 재해석과 원본을 이중으로 검사해 의도가 불분명하다(확장자는 ASCII라 원본 검사만으로 충분하다). 필드명이 `file`이 아니면 multer의 영문 메시지 "Unexpected field"가 400으로 그대로 UI 오류 목록에 표시된다.
- 수정 제안: `Express.Multer.File` 타입을 쓰고, 확장자 검사는 원본 파일명 정규식 하나로 줄인다. 내용 기반 검사로 ZIP 시그니처(선두 4바이트 PK 헤더) 확인을 추가한다. multer 오류를 한글 메시지로 매핑한다.

### L-7 (Low) 다운로드 실패 시 사용자 피드백 없음

- 위치: `apps/web/src/pages/EvalSheetsPage.tsx:90-92`
- 문제: 앵커 태그(`href` + `download`) 방식이라 서버가 500(M-6 등)을 반환하면 브라우저가 JSON 오류 본문을 파일로 받거나 그 페이지로 이동한다. 또 API가 다른 출처(포트)라 `download` 속성은 무시되고 `Content-Disposition`에만 의존한다.
- 수정 제안: `fetch`로 Blob을 받아 `URL.createObjectURL`로 저장하고, 실패하면 error-banner로 안내한다. 그러면 컨트롤러의 `Access-Control-Expose-Headers` 설정도 실제로 쓰이게 된다.

### L-8 (Low) 복원 실패 시 서버 메시지를 버림

- 위치: `apps/web/src/api/client.ts:159-169`
- 문제: 서버가 "이미 기본 평가시트를 사용 중입니다."(400)나 미지원 도메인(404)을 반환해도 항상 "기본 평가시트로 되돌리지 못했습니다."로 표시된다. 다른 탭에서 이미 복원한 경우 사용자가 상황을 알 수 없다.
- 수정 제안: 응답 본문의 `message`를 읽어 표시한다. 400 "이미 기본"은 성공으로 보고 목록을 새로고침한다.

### L-9 (Low) 설정/운영 문서 누락

- 위치: `packages/eval-schema/src/loader.ts:52-57`, `.env.example`
- 문제: `.env.example`에 `EVAL_SHEETS_OVERRIDE_DIR`가 없다. `EVAL_SHEETS_DIR`를 리포지토리 밖 경로(예: `/opt/sheets`)로 지정하면 기본 override 경로가 상위 디렉터리 2단계 계산 때문에 `/data/eval-sheets-override`(파일시스템 루트)가 되어 권한 오류가 날 수 있다.
- 수정 제안: `.env.example`에 플레이스홀더와 설명을 추가한다. `EVAL_SHEETS_DIR`가 지정되었으면 override 경로도 필수로 요구하거나, 리포지토리 루트 탐색 결과에서 기본값을 계산한다.

## 5. 테스트 커버리지 공백

| 공백                             | 관련 이슈 | 제안 테스트                                                  |
|----------------------------------|-----------|--------------------------------------------------------------|
| 희소 대형 시트(먼 행의 셀 1개)   | H-1       | 100만 행 탭 업로드가 빠르게 오류/무시로 끝나는지             |
| 시트 변경 후 과거 결과 점수 보정 | H-2       | maxScore 축소/항목 추가/삭제 후 보정 시 무결성 유지          |
| 버전 충돌(복원 후 재업로드)      | M-2       | 복원 후 재업로드 시 이전 버전과 다른 식별자 발급             |
| 다회 업로드 itemId 재사용        | M-3       | 삭제 후 추가한 항목이 삭제된 ID를 재사용하지 않는지          |
| 쓰기 실패/동시 업로드            | M-4       | 2번째 도메인 저장 실패 시 롤백, 병렬 importWorkbook 호출     |
| 손상된 override 파일             | M-6       | list/채점/결과 조회의 동작과 메시지                          |
| 컨트롤러 계층                    | L-6       | 파일 없음 400, 확장자 오류 400, 5MB 초과 413, 필드명 오류    |
| 파서 경계 케이스                 | L-2, L-3  | 탭 번호 중복, 병합된 구분 셀, 게이팅 공란, 수식 배점, 빈 행  |
| 프론트엔드                       | M-7, L-7  | 검증 오류 목록, ignoredSheets 경고, 413/네트워크 오류 표시   |

## 6. 종합 의견

**판정: 수정 필요**

PII/비밀정보 관점에는 문제가 없고, 빌드/린트/기존 테스트도 모두 통과한다. 다운로드-업로드 왕복, ID 유지, all-or-nothing 검증 등 핵심 흐름도 요구사항대로 동작한다. 다만 다음 두 가지는 다음 단계(test-automation)로 넘어가기 전에 backend-implementer가 수정해야 한다.

- **H-1**: 6KB 파일 하나로 무인증 API를 크래시시킬 수 있다.
- **H-2**: 시트 수정 후 과거 결과를 점수 보정하면 score > maxScore가 저장되고, 과거 결과가 새 기준으로 다시 쓰이거나 502로 막힌다. 프로젝트의 배점 무결성 원칙과 요구사항("저장된 결과는 당시 기준 유지")을 모두 위반한다.

M-1~M-8은 같은 재작업 사이클에서 함께 처리하길 권한다. 특히 M-2/M-3는 H-2의 스냅샷 설계와 맞물려 있어 함께 설계해야 한다. M-7, L-7, L-8은 frontend-implementer 대상이다. Low 이슈는 같은 사이클에서 바로 수정할지 사용자에게 확인한 뒤 진행한다.
