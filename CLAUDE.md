# Auto QA — 프로젝트 가이드 (PM 오케스트레이션 런북)

콜센터 상담대화(Text)를 도메인별로 분류하고, 도메인에 맞는 평가시트 기준으로 Claude API에게 채점을 의뢰하여 항목별 점수·사유·총점을 Web 화면에 출력하는 Auto QA 시스템.

## 아키텍처 요약

- **모노레포**: pnpm workspaces (`apps/*`, `packages/*`)
- **apps/web**: React(Vite) — 트랜스크립트 입력/결과 화면
- **apps/api**: NestJS — ingestion / classification / evaluation / sheets / audit 모듈
- **packages/shared-types**: FE/BE 공유 DTO
- **packages/eval-schema**: 평가시트 JSON Schema + zod 검증 + seed 로더
- **packages/pii-mask**: 한국형 PII 마스킹(RRN/전화번호/카드번호/계좌번호/이메일)
- **infra**: docker-compose, Dockerfile
- **seed/eval-sheets**: 샘플 평가시트(JSON) — 실제 10종 반입 전 개발/검증용
- **docs**: requirements / design / architecture / review / test / deploy / decisions

상세 설계는 최초 승인된 계획 문서(요구사항/아키텍처/데이터모델/LLM 연동/단계별 전개)를 따른다. 도메인/평가시트/LLM 연동 관련 세부 사항은 `docs/architecture/`, `packages/eval-schema/`를 참조.

## 서브에이전트 구성 (`.claude/agents/`)

| 파일 | 역할 | 산출물 |
|---|---|---|
| `requirements-analyst.md` | 요구사항 상세화, 수용기준(AC) 정의 | `docs/requirements/<feature>.md` |
| `ui-designer.md` | 화면흐름/컴포넌트 명세 (코드 작성 없음) | `docs/design/<feature>-ui-spec.md` |
| `backend-implementer.md` | NestJS API, Prisma 스키마, LLM 연동 구현 | `apps/api/**`, `packages/eval-schema/**` |
| `frontend-implementer.md` | React UI 구현 | `apps/web/**` |
| `code-reviewer.md` | 코드품질/보안/PII 처리 검증 (읽기전용) | `docs/review/<feature>-review.md` |
| `test-automation.md` | 단위/통합/LLM-eval 회귀 테스트 작성·실행 | `*.spec.ts`, `docs/test/<feature>-report.md` |
| `git-manager.md` | 커밋 메시지, 브랜치/태그, PR 초안 | 커밋, `docs/changelog` |
| `deployment-engineer.md` | Docker Compose, 배포 스크립트, CI 워크플로 | `infra/**`, `docs/deploy/<phase>-deploy.md` |

PM(메인 세션)은 별도 서브에이전트 파일 없이 이 문서와 `.claude/commands/new-feature.md`의 절차를 직접 수행한다. 서브에이전트는 독립된 컨텍스트로 실행되므로, 단계 간 인계는 **디스크상의 문서 파일 경로를 프롬프트에 명시**하는 방식으로 이루어진다.

## 기능 단위 개발 절차 (PM 런북)

새 기능/Phase를 진행할 때 다음 순서를 따른다 (자세한 매크로는 `/new-feature` 참조):

1. `requirements-analyst` 호출 → `docs/requirements/<feature>.md` 작성
2. `ui-designer` 호출(요구사항 문서 참조) → `docs/design/<feature>-ui-spec.md` 작성
3. `backend-implementer` 호출(요구사항+설계 문서 참조) → API/스키마/LLM 서비스 구현
4. `frontend-implementer` 호출(동일 문서 + 백엔드 계약 참조) → 화면 구현
5. `code-reviewer` 호출 → `docs/review/<feature>-review.md`; 이슈 발견 시 해당 implementer 재호출·반복
6. `test-automation` 호출 → 테스트 작성/실행, `docs/test/<feature>-report.md`; 실패 시 재호출·반복
7. `git-manager` 호출 → **사용자 승인 후에만** 커밋 (자동 커밋 금지 원칙 준수)
8. `deployment-engineer` 호출 → 로컬 실행/배포 확인, `docs/deploy/<phase>-deploy.md`

## 컨벤션

### 기술 문서 작성 형식 (`docs/**/*.md` 전체 — requirements-analyst/ui-designer/code-reviewer 등 문서 산출물에 적용)

- 인코딩: UTF-8
- 문법: GitHub Flavored Markdown (GFM)
- 표: 셀 내부에 줄바꿈(`<br>`, 개행문자)을 넣지 않는다. 각 셀은 한 줄로 작성하고, 열 너비는 균등하게 맞춘다(파이프 정렬).
- 다이어그램: Mermaid 코드 블록(```mermaid)으로 작성한다. 동일한 다이어그램을 PNG로도 별도 저장한다(파일명은 원본 문서와 같은 디렉터리에 `<문서명>-<다이어그램식별자>.png`). 렌더링은 `@mermaid-js/mermaid-cli`(`mmdc`, `npx puppeteer browsers install chrome-headless-shell`로 브라우저 선설치 필요)를 우선 시도하되, 이 Windows 개발 환경에서는 puppeteer가 로컬 Chrome DevTools Protocol 연결에서 `Network.enable timed out`으로 멎는 경우가 있었다. 이 경우 `https://mermaid.ink/img/{mermaid 소스의 base64url 인코딩}?type=png&bgColor=white`(공개 렌더링 서비스)로 폴백한다 — 다이어그램 소스는 민감정보를 포함하지 않으므로 외부 전송이 허용된다.
- 줄바꿈: LF(유닉스 스타일). CRLF로 저장하지 않는다.
- 파일 확장자: `.md`

- 커밋은 Conventional Commits 형식(`feat:`, `fix:`, `docs:`, `test:`, `chore:` 등), 사용자 명시적 요청 시에만 생성.
- 평가시트/트랜스크립트 원문은 절대 git에 커밋하지 않는다 (`seed/eval-sheets/*.json`의 **샘플** 데이터만 예외).
- `ANTHROPIC_API_KEY`는 `.env`로만 관리, `.env`는 git 추적 제외. `.env.example`에 플레이스홀더만 유지.
- 트랜스크립트 원문은 PII 마스킹 후에만 LLM 전송 및 저장한다. 원문을 영구 저장하지 않는다(기본 정책).
- **LLM Provider는 추상화되어 있다** (`LlmEvaluationProvider` 인터페이스). 실제 API 키가 아직 없으므로 기본값은 `mock` 프로바이더(결정론적 더미 채점 응답)이며, env `LLM_PROVIDER=mock|anthropic|gemini`로 전환한다. `anthropic`은 `claude-sonnet-5`(env `ANTHROPIC_MODEL`)/분류용 `claude-haiku-4-5-20251001`, `gemini`는 추후 Google AI Studio 키 확보 시 연동. 세 프로바이더 모두 동일한 구조화 출력 스키마(§`docs/architecture/eval-sheet-schema.md`)를 반환해야 한다.
- **비밀키 취급 주의**: API 키는 절대 채팅/커밋 메시지/로그에 평문으로 남기지 않는다. 사용자가 실수로 채팅에 붙여넣은 키는 노출된 것으로 간주하고 재발급을 권고한다.

## 단계별 전개 (Phase)

0. Bootstrap → 1. Vertical Slice(통신 도메인) → 2. Multi-domain → 3. PII 마스킹 강화 → 4. 실제 평가시트 반입 → 5. 테스트 자동화 확장 → 6. CI/배포

각 Phase의 상세 범위/완료기준은 최초 승인 계획 문서 및 `docs/decisions/`를 참조.
