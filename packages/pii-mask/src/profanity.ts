/**
 * 욕설·비속어 탐지 (Phase 1 FR-8 → Phase 3 FR-3: 어절/형태소 경계 기반 판정으로 전환).
 *
 * 참고: docs/requirements/phase3-pii-hardening.md §5(옵션 B 채택), FR-3.
 *
 * ── 설계 개요(§5.2 옵션 B) ────────────────────────────────────────────────
 * 기존(Phase 1) 방식은 "문장 전체에 대한 부분 문자열 매칭 + 접미어/선행어 블랙리스트
 * (negative lookahead/lookbehind)"였다. 이 방식은 오탐이 보고될 때마다 블랙리스트를
 * 추가하는 대증 요법이라 새 오탐 표면이 계속 남는다는 문제가 재리뷰(M-3)에서 지적되었다.
 *
 * Phase 3는 이를 "어절(token) 단위 경계 판정"으로 전환한다:
 *   1. 문장을 화자 접두어 파싱 후 공백 기준 어절로 분할한다(FR-3.1).
 *   2. 어절 내부에서 "복합 비속어 사전"(FR-3.3)에 등록된 형태를 최우선 탐색한다(최장일치).
 *   3. 없으면 "비속어 어간"을 탐색하고, 어간 앞에 다른 형태소가 남아있으면(prefixRemainder)
 *      합성어로 간주해 미탐지 처리한다(FR-3.2 — "강아지새끼" 류).
 *   4. 어간 뒤 잔여 문자열(suffixRemainder)이 없거나 "허용 조사/어미" 목록과 정확히
 *      일치할 때만 비속어 후보로 확정하고, 그 외(다른 명사로 이어짐)에는 미탐지 처리한다
 *      (FR-3.2). 이 규칙만으로 "시발점/시발역/시발택시/새끼손가락/새끼발가락/새끼고양이/
 *      병신년(丙申年)" 같은 케이스가 접미어 블랙리스트 없이 자동으로 제외된다.
 *   5. 정상어 allowlist(FR-3.4)와, 어간이 공백으로 분리된 직전 어절과 결합해 합성어를
 *      이루는 경우(예: "강아지 새끼를")에 대한 데이터 기반 예외(PRECEDING_WORD_EXCEPTIONS)를
 *      마지막으로 적용한다.
 *
 * §1.1 fail-open 원칙: 비속어 탐지는 판정이 애매하면 "탐지하지 않는다". 오탐(빨강 배지 오표시)
 * 이 미탐(코칭 신호 1건 누락)보다 상담사에게 더 큰 피해를 주기 때문이다.
 */

import {
  ALLOWED_ENDINGS,
  NORMAL_WORD_ALLOWLIST,
  PRECEDING_WORD_EXCEPTIONS,
  PROFANITY_COMPOUNDS,
  PROFANITY_STEMS,
} from './profanity-data';

export type Speaker = 'customer' | 'agent';

export interface ProfanityMatch {
  speaker: Speaker;
  maskedText: string;
}

export interface ProfanityCheckResult {
  detected: boolean;
  matches: ProfanityMatch[];
}

const AGENT_PREFIX = /^\s*(상담사|상담원|에이전트|agent)\s*[:：]/i;
const CUSTOMER_PREFIX = /^\s*(고객|customer)\s*[:：]/i;

interface SpeakerLine {
  speaker: Speaker;
  /** 화자 표기 접두어("상담사:"/"고객:")를 제거한 순수 발화 텍스트. */
  text: string;
}

/** "상담사: ..." / "고객: ..." 형태의 줄바꿈 기반 화자 표기를 파싱한다. 미표기 줄은 직전 화자에
 * 귀속되며, 최초 화자가 없으면 'agent'로 간주한다. 반환되는 text는 화자 접두어가 제거된 순수
 * 발화만 담는다(UI에 화자 라벨과 중복 표시되지 않도록). — Phase 1 동작 그대로 유지(FR-3.5). */
function parseSpeakerLines(text: string): SpeakerLine[] {
  const lines = text.split(/\r?\n/);
  const result: SpeakerLine[] = [];
  let currentSpeaker: Speaker = 'agent';

  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let content = line;
    if (AGENT_PREFIX.test(line)) {
      currentSpeaker = 'agent';
      content = line.replace(AGENT_PREFIX, '').trim();
    } else if (CUSTOMER_PREFIX.test(line)) {
      currentSpeaker = 'customer';
      content = line.replace(CUSTOMER_PREFIX, '').trim();
    }
    result.push({ speaker: currentSpeaker, text: content });
  }
  return result;
}

interface TokenMatch {
  /** core 문자열 기준 매치 시작 인덱스 */
  start: number;
  /** core 문자열 기준 매치 끝 인덱스(exclusive) */
  end: number;
}

/** 어절 하나(구두점 제거된 core)를 분석해 비속어 매치 위치를 반환한다. 매치가 없으면 null. */
function analyzeToken(core: string, prevCore: string | null): TokenMatch | null {
  if (core.length === 0) return null;

  // FR-3.3: 복합 비속어 사전 — 최장일치, 발견 즉시 확정(잔여 검사 불필요).
  let compoundMatch: TokenMatch | null = null;
  for (const compound of PROFANITY_COMPOUNDS) {
    const idx = core.indexOf(compound);
    if (idx === -1) continue;
    if (!compoundMatch || compound.length > compoundMatch.end - compoundMatch.start) {
      compoundMatch = { start: idx, end: idx + compound.length };
    }
  }
  if (compoundMatch) return compoundMatch;

  // FR-3.1/3.2: 비속어 어간 탐색(최장일치).
  let stemHit: { idx: number; stem: string } | null = null;
  for (const stem of PROFANITY_STEMS) {
    const idx = core.indexOf(stem);
    if (idx === -1) continue;
    if (!stemHit || stem.length > stemHit.stem.length) {
      stemHit = { idx, stem };
    }
  }
  if (!stemHit) return null;

  const { idx, stem } = stemHit;
  const prefixRemainder = core.slice(0, idx);
  const suffixRemainder = core.slice(idx + stem.length);

  // FR-3.2: 어간 앞에 다른 한글 형태소가 남아있으면 합성어로 간주해 미탐지한다(예:
  // "강아지새끼"). 복합 사전에 등록된 형태는 위에서 이미 처리되었으므로 여기 도달하지 않는다.
  if (prefixRemainder.length > 0) return null;

  // FR-3.2: 잔여가 없거나 허용 조사/어미와 정확히 일치할 때만 후보로 확정한다. 그 외(다른
  // 명사로 이어짐)에는 미탐지 처리한다 — 접미어 블랙리스트 없이 "시발점/시발역/시발택시/
  // 새끼손가락/새끼발가락/새끼고양이/병신년(丙申年)"이 여기서 자동 제외된다.
  const suffixOk = suffixRemainder.length === 0 || ALLOWED_ENDINGS.includes(suffixRemainder);
  if (!suffixOk) return null;

  // FR-3.4: 어절 전체(core)가 정상어 allowlist와 일치하면 미탐지.
  if (NORMAL_WORD_ALLOWLIST.includes(core)) return null;

  // M-3: 어간과 예외 단어가 공백으로 분리된 별도 어절인 경우("강아지 새끼를 키워요")의
  // 데이터 기반 예외 처리.
  const precedents = PRECEDING_WORD_EXCEPTIONS[stem];
  if (precedents && prevCore && precedents.includes(prevCore)) return null;

  return { start: idx, end: idx + stem.length };
}

/**
 * M-4(FR-3.1): 어절 분할을 "공백"뿐 아니라 "문장부호/기호"까지 구분자로 확장한다. 종전에는
 * 공백으로만 분할한 뒤 어절 양 끝의 문장부호만 제거했기 때문에, 어절 내부에 문장부호가
 * 있으면("아니 씨발,진짜", "씨발...진짜") 잔여 판정에서 탈락해 미탐이 발생했다(리뷰 M-4).
 * `\p{P}`(문장부호)·`\p{S}`(기호)·공백을 모두 구분자로 취급하도록 분할 정규식을 확장하면,
 * 한글/한자/영문/숫자(\p{L}, \p{N})만 남는 어절이 만들어져 별도의 "핵심 문자열 추출"
 * (edge-stripping) 없이 바로 analyzeToken에 넘길 수 있다.
 */
const TOKEN_DELIMITER_PATTERN = /([\s\p{P}\p{S}]+)/u;
const IS_DELIMITER_ONLY_PATTERN = /^[\s\p{P}\p{S}]+$/u;

/** 한 줄(화자 접두어 제거됨)을 처리해 비속어를 고정 길이(`***`)로 치환한다(FR-3.5 권고 반영 —
 * 길이 정보를 노출하는 `'*'.repeat(word.length)` 대신 고정 마스크 사용). 공백·문장부호를
 * 구분자로 삼아 어절 단위로 순회하되(FR-3.1), 원본 구분자는 그대로 보존한다. */
function maskLineProfanity(text: string): { changed: boolean; text: string } {
  // 캡처 그룹을 포함한 split은 구분자(공백/문장부호)도 결과 배열에 포함시켜, 원문을 그대로
  // 복원할 수 있게 한다.
  const parts = text.split(TOKEN_DELIMITER_PATTERN);
  let changed = false;
  let prevCore: string | null = null;

  const outParts = parts.map((part) => {
    if (part.length === 0 || IS_DELIMITER_ONLY_PATTERN.test(part)) return part;

    // 구분자가 문장부호까지 확장되었으므로, 여기 도달하는 part는 이미 \p{L}/\p{N}만 남은
    // "핵심 문자열"이다(edge-stripping 불필요).
    const core = part;
    const match = analyzeToken(core, prevCore);
    prevCore = core;

    if (!match) return part;

    changed = true;
    const before = part.slice(0, match.start);
    const after = part.slice(match.end);
    return `${before}***${after}`;
  });

  return { changed, text: outParts.join('') };
}

/** 이미 PII 마스킹이 끝난 텍스트(maskedTranscript)에 대해 비속어를 탐지한다. 욕설이 포함되지
 * 않은 문장은 결과에 포함하지 않으며(전체 대화 미노출), 포함된 경우에도 화자 접두어 없이
 * 해당 문장만 반환한다. */
export function detectProfanity(maskedTranscript: string): ProfanityCheckResult {
  const lines = parseSpeakerLines(maskedTranscript);
  const matches: ProfanityMatch[] = [];

  for (const line of lines) {
    const { changed, text } = maskLineProfanity(line.text);
    if (changed) {
      matches.push({ speaker: line.speaker, maskedText: text });
    }
  }

  return { detected: matches.length > 0, matches };
}
