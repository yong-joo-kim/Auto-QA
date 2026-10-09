# 평가시트 Excel 업로드/다운로드 + 사용자 수정 기준 적용 — 로컬 실행/배포 확인

- 관련 문서: `docs/requirements/eval-sheet-upload-download.md`, `docs/review/eval-sheet-upload-download-review.md`, `docs/test/eval-sheet-upload-download-report.md`
- 검증 환경: Windows 11, Node v24.19.0, pnpm, SQLite(Prisma 5.22.0), `LLM_PROVIDER=mock`
- 범위: 로컬 실행 경로에서 신규 마이그레이션 적용과 API 스모크 테스트. 원격/클라우드 배포는 수행하지 않았다.

## 1. 확인 결과 요약

| 항목 | 결과 |
| --- | --- |
| 마이그레이션 `20261009000000_add_eval_sheet_snapshot` 적용 | 통과 - 개발 DB 적용 완료, 데이터 60/60건 보존 |
| 파괴적 변경 여부 | 없음 - 이 기능 마이그레이션은 `ADD COLUMN`(nullable) 1건 |
| `infra/` 점검 | 해당 없음 - 디렉터리 자체가 없음(§3) |
| API 스모크 테스트(mock, 임시 DB/override 경로) | 통과 - §4 |
| web 기동 / 실제 브라우저 확인 | 미확인 - §6 |

## 2. Prisma 마이그레이션 적용

### 2.1 사전 확인

| 항목 | 값 |
| --- | --- |
| 대상 DB 파일 | `apps/api/prisma/dev.db` (`DATABASE_URL=file:./dev.db`, schema 디렉터리 기준 상대경로) |
| 적용 전 데이터 | transcripts 60건, evaluations 60건 |
| `prisma migrate status` | 4개 중 미적용은 `20261009000000_add_eval_sheet_snapshot` 1건뿐 |
| `20260913233527_add_pii_check` | 이미 적용되어 있었음(이번 적용 대상 아님) |
| 백업 | `apps/api/prisma/dev-backup-20261009-pre-snapshot.db` (원본과 SHA-256 일치 확인, `*.db` 규칙으로 git 추적 제외) |

### 2.2 적용

```bash
cd apps/api
npx prisma migrate deploy
npx prisma migrate status   # Database schema is up to date!
```

적용된 SQL은 `ALTER TABLE "evaluations" ADD COLUMN "evalSheetSnapshot" TEXT;` 한 줄이다. DROP/데이터 손실 없음. 적용 후 transcripts 60건, evaluations 60건으로 변동이 없고, 기존 60건의 `evalSheetSnapshot`은 모두 NULL이다(과거 평가는 스냅샷 없이 기존 방식으로 조회되는 설계, 요구사항 문서 참조).

롤백이 필요하면 API를 중지한 뒤 백업 파일을 `dev.db`로 복사하고 `_prisma_migrations`에서 해당 행이 사라진 상태이므로 코드도 이전 버전으로 되돌려야 한다.

## 3. infra 점검 (override 경로 / CORS_ORIGINS)

`infra/`(`docker-compose.yml`, `Dockerfile.*`)와 `.github/workflows/`는 저장소에 존재하지 않는다(`git ls-files` 결과 0건, Phase 6 범위). 수정할 대상이 없으므로 인프라 파일은 변경하지 않았다. Phase 6에서 compose를 신설할 때 다음을 반영해야 한다.

| 항목 | 요구사항 |
| --- | --- |
| `EVAL_SHEETS_OVERRIDE_DIR` | 컨테이너 내 쓰기 가능한 경로로 지정하고 named volume 또는 bind mount로 영속화한다. 미설정 시 기본값(리포지토리 루트 `data/eval-sheets-override`)은 컨테이너 재생성 시 사라진다 |
| `CORS_ORIGINS` | 실제 웹 주소를 쉼표로 지정한다. 미설정 시 `http://localhost:5173`, `http://127.0.0.1:5173`만 허용되므로 컨테이너 웹 포트(예: 80)를 쓰면 업로드/복원이 403이 된다. 웹과 API를 같은 호스트로 프록시하면 same-host 규칙으로 통과한다 |
| SQLite 파일 | 현재 기본 DB도 컨테이너 내부 파일이므로 volume 마운트가 필요하다. 기동 시 `prisma migrate deploy` 실행 단계가 필요하다 |

`.env.example`에는 두 변수가 이미 반영되어 있다(`CORS_ORIGINS`, `EVAL_SHEETS_OVERRIDE_DIR`).

## 4. API 스모크 테스트

조건: `node dist/main.js`(`pnpm --filter @auto-qa/api build` 후), 포트 3917, `LLM_PROVIDER=mock`, `CORS_ORIGINS=http://localhost:5173`. 개발 DB를 오염시키지 않도록 임시 SQLite 파일(스크래치 디렉터리, `migrate deploy`로 생성)과 임시 `EVAL_SHEETS_OVERRIDE_DIR`을 사용했다.

| 번호 | 요청 | 기대 | 결과 |
| --- | --- | --- | --- |
| 1 | `GET /eval-sheets` | 10종 목록, 모두 `customized=false` | 통과 |
| 2 | `GET /eval-sheets/download` | 200, xlsx MIME, `Content-Disposition` 한글 파일명, `PK` 시그니처 | 통과 - 25,228바이트, 시트 11개(안내 + 도메인 10종) |
| 3 | 통신 시트 첫 항목명 변경 후 `POST /eval-sheets/upload` (허용 Origin) | 200, `updated`에 telecom, 안내 시트는 `ignoredSheets` | 통과 - 버전 `1.0.1+efd7dade` |
| 4 | 위 업로드를 `Origin: http://evil.example`로 요청 | 403 | 통과 |
| 5 | `GET /eval-sheets` | telecom `customized=true`, 새 버전 | 통과 |
| 6 | `POST /transcripts` (telecom) 후 `GET /evaluations/:id` | items에 수정된 항목명 존재 | 통과 - 수정명 확인, `evalSheetVersion=1.0.2+efd7dade`(재업로드 후 평가) |
| 7 | `DELETE /eval-sheets/telecom/override` with `Origin: http://evil.example` | 403 | 통과 |
| 8 | `DELETE /eval-sheets/telecom/override` with 허용 Origin | 204, 이후 telecom `customized=false`, 버전 `1.0.0` | 통과 |
| 9 | 복원 후 이전(수정 기준) 평가 재조회 | 평가 당시 스냅샷의 수정 항목명 유지 | 통과 |
| 10 | `GET /eval-sheets` with 허용 Origin / 차단 Origin | 허용 시 `Access-Control-Allow-Origin` 반영, 차단 시 헤더 없음 | 통과 (차단 Origin의 GET은 200이나 CORS 헤더가 없어 브라우저가 응답을 읽을 수 없다. Origin 검증 가드는 상태 변경 엔드포인트에만 적용되는 설계) |

참고: 6번에서 버전이 `1.0.2`인 것은 3번 업로드 후 복원(8번 상당)하고 같은 파일을 재업로드했기 때문이며, 복원 후 재업로드 시 개정 이력에 따라 패치 버전이 이어서 증가하는 동작이 관찰되었다.

정리: API 프로세스를 종료했고(포트 3917 응답 없음 확인), 임시 DB, override 파일, 다운로드/수정본 xlsx를 모두 삭제했다. 리포지토리 루트 `data/` 디렉터리는 생성되지 않았다. 개발 DB의 transcripts/evaluations 건수는 스모크로 인해 변하지 않았다.

## 5. 실행 방법 요약

```bash
pnpm install
pnpm --filter @auto-qa/api exec prisma migrate deploy   # 최초/업데이트 시 (백업 후)
pnpm dev                                                 # API 3000, Web 5173
```

확인: `curl http://localhost:3000/eval-sheets` (전용 `/health`는 여전히 없음).

## 6. 미확인 항목 및 알려진 제약

| 항목 | 상태 |
| --- | --- |
| web 앱 기동 및 화면(평가시트 관리 페이지 업로드/다운로드/복원 UI) | 미확인 - 이번 작업은 API 중심 스모크만 수행 |
| 실제 브라우저(claude-in-chrome) 동작, 파일 다운로드 대화상자, CORS 프리플라이트 | 미확인 - 범위 외 |
| `LLM_PROVIDER=gemini` 실호출 시 수정된 시트 반영 | 미확인 - mock만 사용 |
| Docker Compose 기동, 볼륨 영속성 | 해당 없음 - infra 미구축(§3) |
| 업로드 인증/권한 | 없음. Origin 검증은 임시 CSRF 완화책이며 인증을 대체하지 않는다 |
| 다중 인스턴스 | override가 로컬 파일이므로 인스턴스 간 공유되지 않는다 |

커밋은 수행하지 않았다.
