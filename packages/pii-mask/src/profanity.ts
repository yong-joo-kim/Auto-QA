/**
 * 욕설·비속어 탐지 (FR-8, §4.3-10) — 최소 구현: 금칙어 키워드 목록 기반 정규식 매칭.
 *
 * 탐지된 문장은 화자(고객/상담사)로 구분되어 반환되며, 비속어 단어 자체는 응답에도
 * 포함하지 않고 '*'로 치환한다(원문 비속어 비노출 원칙, NFR-1과 동일 취급).
 * 탐지 여부는 시드 기반이 아니라 실제 텍스트 매칭 결과를 따르므로, 동일 입력에는
 * 항상 동일한 결과가 나온다(재현성은 자동 보장).
 */

export type Speaker = 'customer' | 'agent';

export interface ProfanityMatch {
  speaker: Speaker;
  maskedText: string;
}

export interface ProfanityCheckResult {
  detected: boolean;
  matches: ProfanityMatch[];
}

interface ProfanityWordSpec {
  word: string;
  /**
   * 이 단어 바로 뒤(사이에 조사/공백이 있어도 됨)에 오면 오탐(false positive)으로 간주해
   * 매칭에서 제외할 접미어 목록.
   * 예: "새끼" 자체는 비속어이지만 "새끼손가락"/"새끼발가락"/"새끼 고양이"처럼 신체 부위·동물
   * 명칭의 일부로 쓰이는 경우가 많아 오탐이 잦다(M-3). negative lookahead로 이런 케이스를
   * 완화한다. 조사(을/를/이/가/도/는/은)와 공백은 있어도/없어도 모두 허용한다(M-3 재리뷰:
   * "새끼 줄 좀 주세요"처럼 공백만 있고 조사가 없는 경우도 오탐 방지 대상).
   */
  falsePositiveSuffixes?: string[];
  /**
   * 이 단어 바로 앞(사이에 공백이 있어도 됨)에 오면 오탐으로 간주해 매칭에서 제외할 선행어
   * 목록. 예: "강아지 새끼를 키워요"처럼 동물 이름이 앞에 오고 "새끼" 뒤에는 조사·동사만
   * 오는 경우, 접미어 검사만으로는 걸러지지 않아 별도의 negative lookbehind가 필요하다(M-3
   * 재리뷰).
   */
  falsePositivePrecedents?: string[];
}

// 최소 구현용 금칙어 목록 (필요 시 확장). 상용화 시 별도 운영 사전으로 교체 권장.
const PROFANITY_WORD_SPECS: ProfanityWordSpec[] = [
  { word: '씨발' },
  { word: '씨팔' },
  // M-3 재리뷰: "시발점"(기점)/"시발역"/"시발택시"처럼 교통·업무 용어의 일부로 쓰이는 경우가
  // 있어 오탐이 발생한다. 해당 접미어만 예외 처리하고, "시발" 단독/그 외 용법은 그대로 탐지한다.
  { word: '시발', falsePositiveSuffixes: ['점', '역', '택시'] },
  { word: '개새끼' },
  {
    word: '새끼',
    falsePositiveSuffixes: ['손가락', '발가락', '손톱', '발톱', '줄', '고양이', '강아지'],
    falsePositivePrecedents: ['강아지', '고양이', '동물'],
  },
  // M-3 재리뷰: "병신년(丙申年)"처럼 60갑자 연도 표기의 일부로 쓰이는 경우를 예외 처리한다.
  { word: '병신', falsePositiveSuffixes: ['년'] },
  { word: '지랄' },
  { word: '미친놈' },
  { word: '미친년' },
  { word: '닥쳐' },
  // M-3 재리뷰: "화면이 꺼져서요"/"불이 꺼져 있어요"처럼 통신/IT 상담에서 기기·화면 전원
  // 상태를 설명할 때 매우 흔히 쓰인다. "꺼져" 단독(명령형 욕설, 예: "저리 꺼져!")은 그대로
  // 탐지하되, 상태 서술에 흔히 붙는 어미/보조용언(서/있/버려/버렸/진) 앞에서는 제외한다.
  { word: '꺼져', falsePositiveSuffixes: ['서', '있', '버려', '버렸', '진'] },
  { word: '개소리' },
];

function buildWordPattern(spec: ProfanityWordSpec): string {
  let pattern = spec.word;

  if (spec.falsePositivePrecedents && spec.falsePositivePrecedents.length > 0) {
    // 선행어와 이 단어 사이에 공백이 있어도(없어도) 오탐으로 간주한다.
    pattern = `(?<!(?:${spec.falsePositivePrecedents.join('|')})\\s*)${pattern}`;
  }

  if (spec.falsePositiveSuffixes && spec.falsePositiveSuffixes.length > 0) {
    // 이 단어와 접미어 사이에 조사(을/를/이/가/도/는/은)와 공백이 있어도(없어도) 오탐으로
    // 간주한다.
    pattern = `${pattern}(?!(?:을|를|이|가|도|는|은)?\\s*(?:${spec.falsePositiveSuffixes.join('|')}))`;
  }

  return pattern;
}

const PROFANITY_PATTERN = new RegExp(PROFANITY_WORD_SPECS.map(buildWordPattern).join('|'), 'g');

const AGENT_PREFIX = /^\s*(상담사|상담원|에이전트|agent)\s*[:：]/i;
const CUSTOMER_PREFIX = /^\s*(고객|customer)\s*[:：]/i;

interface SpeakerLine {
  speaker: Speaker;
  /** 화자 표기 접두어("상담사:"/"고객:")를 제거한 순수 발화 텍스트. */
  text: string;
}

/** "상담사: ..." / "고객: ..." 형태의 줄바꿈 기반 화자 표기를 파싱한다. 미표기 줄은 직전 화자에 귀속되며, 최초 화자가 없으면 'agent'로 간주한다. 반환되는 text는 화자 접두어가 제거된 순수 발화만 담는다(UI에 화자 라벨과 중복 표시되지 않도록). */
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

/** 이미 PII 마스킹이 끝난 텍스트(maskedTranscript)에 대해 비속어를 탐지한다. 욕설이 포함되지 않은 문장은 결과에 포함하지 않으며(전체 대화 미노출), 포함된 경우에도 화자 접두어 없이 해당 문장만 반환한다. */
export function detectProfanity(maskedTranscript: string): ProfanityCheckResult {
  const lines = parseSpeakerLines(maskedTranscript);
  const matches: ProfanityMatch[] = [];

  for (const line of lines) {
    PROFANITY_PATTERN.lastIndex = 0;
    if (!PROFANITY_PATTERN.test(line.text)) continue;

    const censored = line.text.replace(PROFANITY_PATTERN, (word) => '*'.repeat(word.length));
    matches.push({ speaker: line.speaker, maskedText: censored });
  }

  return { detected: matches.length > 0, matches };
}
