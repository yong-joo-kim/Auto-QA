# 평가시트 데이터 모델 (확정본 — 실제 Excel 원본 기준)

원본: `docs/source-sheets/3. 도메인별_상담사_평가시트_10종.xlsx` (사내 제공, git 미추적)
변환 스크립트: `scripts/import-eval-sheets.js` (`pnpm import:eval-sheets`로 재실행 가능)
산출물: `seed/eval-sheets/{01..10}-<domainId>.json`

## 공통 구조 (10개 도메인 전부 동일 패턴)

- 100점 만점, 5개 카테고리로 고정:
  - `기본응대`(basic-response) 15점 — 전 도메인 공통 3항목(5점씩)
  - `상담태도`(attitude) 15점 — 전 도메인 공통 3항목(5점씩)
  - `상담전문성`(expertise) 20점 — 도메인별 2항목(10점씩)
  - `처리효율`(efficiency) 20점 — 도메인별 2항목(10점씩)
  - `컴플라이언스`(compliance) 30점 — 도메인별 3~4항목, 배점 상이, **게이팅(P/F) 항목 포함**
- **게이팅(Gating) 규칙**: 컴플라이언스 항목 중 일부는 `gating: true`. 게이팅 항목이 **1건이라도 실패(F)** 판정되면 총점과 무관하게 전체 결과가 **"탈락(재검토 필요)"** 로 처리된다. (원본 시트 `00_안내` 탭 명시)
- **등급 기준**: 90점 이상 우수 / 80~89 양호 / 70~79 보통 / 70 미만 미흡. 단, 게이팅 탈락 시 등급과 무관하게 탈락 처리.
- 도메인별로 `주요 상담 유형` 설명 텍스트와 컴플라이언스 항목 `출처(source citation)`가 부여되어 있음(법령/공식 안내 근거).
- 원본에는 "배점·가중치는 참고용 설계 예시[가정]"라는 면책 문구가 포함되어 있어, 실제 운영 반영 전 사내 최신 규정 대조가 필요함을 명시.

## 도메인 목록 (10종, `domainId`)

| # | domainId | domainName |
|---|---|---|
| 1 | finance-banking-card | 금융(은행·카드) |
| 2 | insurance | 보험 |
| 3 | telecom | 통신(이동통신·인터넷) |
| 4 | ecommerce-retail | 이커머스·유통 |
| 5 | public-service | 공공기관·민원 |
| 6 | healthcare | 의료·헬스케어 |
| 7 | it-support | IT·SW기술지원 |
| 8 | travel-lodging | 여행·숙박 |
| 9 | delivery-o2o | 배달·O2O |
| 10 | utility | 유틸리티(전기·가스) |

## JSON 스키마 (실측 반영)

```jsonc
{
  "domainId": "telecom",
  "domainName": "통신(이동통신·인터넷)",
  "version": "1.0.0",
  "mainConsultationTypes": "요금제 변경, 결합/부가서비스, 단말기 지원금, 해지·번호이동",
  "totalMaxScore": 100,
  "gradeCriteria": [
    { "minScore": 90, "grade": "우수" },
    { "minScore": 80, "grade": "양호" },
    { "minScore": 70, "grade": "보통" },
    { "minScore": 0,  "grade": "미흡" }
  ],
  "gatingPolicy": "게이팅(P/F) 항목이 1건이라도 실패(F)이면 총점과 무관하게 전체 결과를 탈락(재검토 필요)으로 판정한다.",
  "categories": [
    {
      "categoryId": "compliance",
      "categoryName": "컴플라이언스",
      "maxScore": 30,
      "items": [
        {
          "itemId": "compliance-01",
          "itemName": "지원금·선택약정 설명의무 이행",
          "criteria": "공시지원금·선택약정할인 등 지원금 관련 설명의무를 이행했는가",
          "maxScore": 8,
          "gating": true
        }
      ]
    }
  ],
  "sourceCitation": "출처(컴플라이언스 항목 근거): ...",
  "disclaimer": "※ 배점 및 가중치는 참고용 설계 예시이며[가정], ..."
}
```

## §3(평가시트 데이터 모델) / §4(LLM 연동) 설계 변경 사항

최초 계획(`elegant-skipping-quill.md`)의 §3, §4 대비 다음을 반영해야 한다:

1. `EvaluationItem`에 `gating: boolean` 필드 추가. Prisma 스키마에도 반영.
2. Scoring Aggregator는 `totalScore` 재계산 외에 **게이팅 판정**을 별도로 계산해야 한다: 게이팅 항목 중 하나라도 LLM이 "실패(F)"로 판단하면 `gatingResult: "탈락(재검토 필요)"`, 아니면 `"통과"`. 이 값은 총점/등급과 독립적으로 최종 결과에 병기된다.
3. LLM 구조화 출력 스키마에 항목별 `score`뿐 아니라, `gating: true`인 항목에 대해서는 `passFail: "P" | "F"` 필드를 추가로 받아야 한다(점수만으로는 게이팅 판정이 모호할 수 있음 — 예: 절차 일부 누락은 감점 대상이지만 게이팅 항목은 이진 판정).
4. `gradeCriteria`는 도메인마다 동일(90/80/70 기준)하지만 스키마상 도메인별로 오버라이드 가능하게 유지한다(원본이 도메인별로 값을 복제해 저장하고 있어, 향후 도메인별로 달라질 가능성 대비).
5. UI 상세 결과 화면(`/transcripts/:id`)에는 총점/등급 외에 **게이팅 결과("통과"/"탈락(재검토 필요)")를 총점과 별도로, 더 눈에 띄게** 표시해야 한다(게이팅 실패 시 총점이 높아도 탈락이므로 오해 방지).
6. `sourceCitation`, `disclaimer`는 QA 관리자가 컴플라이언스 배점 근거를 확인할 수 있도록 상세 결과 화면 하단에 표시(선택 사항, Phase 2 이후).

## 재실행 방법 (평가시트 갱신 시)

1. 새 Excel 파일을 `docs/source-sheets/`에 덮어쓰기 (또는 추가 — 스크립트는 폴더 내 첫 `.xlsx`를 사용하므로 파일이 1개만 있어야 함).
2. `pnpm import:eval-sheets` 실행.
3. `seed/eval-sheets/*.json`이 갱신됨. git diff로 변경 내용을 확인 후 커밋 여부 결정.
4. 시트 구조(탭 이름, 컬럼 순서)가 바뀌면 `scripts/import-eval-sheets.js`의 `DOMAIN_MAP`/파싱 로직 수정 필요.
