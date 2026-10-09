# 테스트 리포트: 평가시트 Excel 업로드/다운로드 + 사용자 수정 기준 적용

- 작성일: 2026-10-09
- 작성자: test-automation
- 요구사항: `docs/requirements/eval-sheet-upload-download.md`
- 코드리뷰: `docs/review/eval-sheet-upload-download-review.md` (모든 이슈 수정 완료 상태)

## 1. 테스트 범위

리뷰 문서 5절의 테스트 공백 9개 영역을 기존 테스트와 대조했고, 남은 공백(실제 채점 경로 통합, 프론트 순수 로직)을 이번에 보강했다. 제품 코드(비-spec 파일)는 수정하지 않았다. 실제 LLM 호출은 없다(mock provider만 사용).

## 2. 리뷰 5절 공백 대조

| 공백                             | 이슈     | 커버 테스트 파일                         | 상태                                   |
|----------------------------------|----------|------------------------------------------|----------------------------------------|
| 희소 대형 시트                   | H-1      | `eval-sheet-hardening.spec.ts`           | 기존 커버 (탭 20개 상한 포함)          |
| 시트 변경 후 과거 결과 점수 보정 | H-2      | `transcripts.sheet-change.spec.ts`       | 기존 커버 (스냅샷/레거시/L-5 포함)     |
| 버전 충돌(복원 후 재업로드)      | M-2      | `eval-sheet-hardening.spec.ts`           | 기존 커버 (해시 구분, 직렬화 포함)     |
| 다회 업로드 itemId 재사용        | M-3      | `eval-sheet-hardening.spec.ts`           | 기존 커버 (categoryId 포함)            |
| 쓰기 실패/동시 업로드            | M-4      | `eval-sheet-hardening.spec.ts`           | 기존 커버 (롤백, tmp 정리, 직렬화)     |
| 손상된 override 파일             | M-6      | hardening, `transcripts.sheet-change`    | 기존 커버 (list/채점 503/조회/다운로드) |
| 컨트롤러 계층                    | L-6, M-5 | `eval-sheets.controller.spec.ts`         | 기존 커버 (400/413/Origin 403/DELETE)  |
| 파서 경계 케이스                 | L-2, L-3 | `eval-sheet-parser-edge.spec.ts`         | 부분 커버 (아래 남은 공백 참고)        |
| 프론트엔드                       | M-7, L-7 | `client.eval-sheets.spec.ts` (신규)      | 순수 로직만 커버, 컴포넌트는 공백      |

## 3. 이번에 추가한 테스트

| 파일                                                            | 종류             | 내용                                                                                          |
|-----------------------------------------------------------------|------------------|-----------------------------------------------------------------------------------------------|
| `apps/api/src/transcripts/transcripts.sheet-apply.spec.ts`      | API 통합(mock)   | 업로드한 수정 시트가 createAndEvaluate -> EvaluationService -> MockLlmEvaluationProvider 로 전달되어 수정 항목명/배점으로 결과가 나오는지, 이전 결과는 당시 기준 유지, 타 도메인 무영향, 복원 후 seed 기준 복귀 |
| `apps/web/src/api/client.eval-sheets.spec.ts`                   | Web 단위(vitest) | downloadEvalSheets 파일명 파싱(filename*, 일반 filename, 기본값, 잘못된 인코딩 폴백)과 오류 메시지, resetEvalSheet 서버 메시지 우선/기본 메시지/network, uploadEvalSheets 성공/400 검증 오류/413/500/network 매핑 |

참고 사항은 다음과 같다.

- 항목명을 바꾸면 신규 itemId가 채번되는 것이 제품 규칙이므로(요구사항), 통합 테스트는 이름을 바꾼 항목은 itemId가 달라지고 나머지 항목 id는 유지됨을 검증한다.
- `EvalSheetsService.resetToDefault`는 Promise를 반환(뮤텍스 직렬화)하므로 호출 시 await가 필요하다. 테스트에서 처음 누락해 실패했으며 테스트 코드 문제로 수정했다(제품 결함 아님).

## 4. 실행 결과

| 대상                              | 명령                                   | 결과                                   |
|-----------------------------------|----------------------------------------|----------------------------------------|
| apps/api jest                     | `npx jest` (apps/api)                  | 14 suites / 179 tests 모두 통과        |
| apps/web vitest                   | `npx vitest run` (apps/web)            | 2 files / 21 tests 모두 통과           |
| packages/pii-mask jest            | `npx jest` (packages/pii-mask)         | 3 suites / 168 tests 모두 통과         |
| packages/eval-schema, shared-types | 테스트 스크립트 없음                  | 해당 없음 (평가시트 로직은 apps/api에서 검증) |
| tsc --noEmit                      | apps/api, apps/web, eval-schema, pii-mask, shared-types | 모두 오류 없음 |

합계: 통과 368, 실패 0. 이번에 신규 추가한 테스트는 api 2개, web 13개다.

## 5. 실패 원인 분석

최종 실패 없음. 제품 코드 결함은 발견하지 못했다. 작성 중 발생한 두 건은 모두 테스트 코드 문제였고 수정했다(타입 리터럴 domainId, resetToDefault await 누락).

## 6. 실제 xlsx 원본 의존 여부

`docs/source-sheets/3. 도메인별_상담사_평가시트_10종.xlsx`를 읽는 spec은 없다. 이 경로는 제품 코드(`eval-sheet-xlsx.ts`, `eval-sheets.controller.ts` 주석)와 `scripts/import-eval-sheets.js`에서만 언급된다. 모든 테스트는 seed JSON에서 xlsx를 생성해 사용하므로 원본 파일이 없는 CI에서도 안전하다.

## 7. 남은 공백

| 영역                                              | 사유 / 제안                                                                                  |
|---------------------------------------------------|----------------------------------------------------------------------------------------------|
| EvalSheetsPage 컴포넌트 렌더링(M-7 ignoredSheets 경고 배너, 검증 오류 목록 표시) | web 테스트 환경이 node이고 React 렌더링 라이브러리가 없어 새로 도입하지 않음. 필요 시 jsdom + @testing-library/react 도입을 별도 결정 |
| 파서 경계 케이스 일부                             | parser-edge spec은 L-2, L-3만 다룸. 나머지(탭 번호 중복, 병합 셀, 게이팅 공란, 수식 배점)는 전용 테스트를 확인하지 못해 공백으로 둠. 보강 후보 |
| 실제 LLM(gemini) 수정 시트 채점                   | `@llm-eval` 골든셋이 없어 이번 범위에서 제외 (비용 발생)                                     |
| 실제 DB(Prisma/SQLite) 경유 통합                  | 통합 테스트는 인메모리 fake Prisma 사용. 스냅샷 컬럼 마이그레이션 자체는 미검증              |
| 커버리지 수치                                     | 커버리지 리포터 미구성으로 측정하지 않음                                                     |
