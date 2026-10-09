/**
 * 화자 접두어 파싱 + 문장 분리 — `profanity.ts`(비속어 탐지)와 `pii-detection.ts`(PII 탐지)가
 * 공통으로 필요로 하는 "문장 단위로 잘라서 화자를 붙여 반환" 로직을 한 곳에서 공유한다.
 * 두 탐지기 모두 "이미 마스킹된 텍스트에서, 문제(비속어/PII)가 포함된 문장만 화자와 함께
 * 골라낸다"는 동일한 절차를 따르므로 중복 구현하지 않는다.
 */

export type Speaker = 'customer' | 'agent';

const AGENT_PREFIX = /^\s*(상담사|상담원|에이전트|agent)\s*[:：]/i;
const CUSTOMER_PREFIX = /^\s*(고객|customer)\s*[:：]/i;

export interface SpeakerLine {
  speaker: Speaker;
  /** 화자 표기 접두어("상담사:"/"고객:")를 제거한 순수 발화 텍스트. */
  text: string;
}

/** "상담사: ..." / "고객: ..." 형태의 줄바꿈 기반 화자 표기를 파싱한다. 미표기 줄은 직전 화자에
 * 귀속되며, 최초 화자가 없으면 'agent'로 간주한다. 반환되는 text는 화자 접두어가 제거된 순수
 * 발화만 담는다(UI에 화자 라벨과 중복 표시되지 않도록). */
export function parseSpeakerLines(text: string): SpeakerLine[] {
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

/** 문장 종결 부호(`. ! ?`, 연속 포함) 기준으로 한 줄(화자 발화 전체)을 문장 단위로 분리한다.
 * 종결 부호는 직전 문장에 포함시켜 반환하며(중복/누락 없이 원문을 그대로 재구성 가능), 부호가
 * 전혀 없는 구어체 발화는 줄 전체가 문장 하나로 그대로 반환된다. 완벽한 자연어 문장 분리기가
 * 아니라 "문제가 포함된 문장만 노출"을 위한 실용적 근사치다.
 *
 * 숫자와 숫자 사이의 마침표(예: "3.5만원")는 문장 종결이 아니라 소수점이므로 종결부호에서
 * 제외한다(lookbehind/lookahead로 앞뒤가 모두 숫자인 "."만 제외, "!"/"?"는 그대로 둔다). */
export function splitIntoSentences(text: string): string[] {
  const TERMINATOR_PATTERN = /(?:(?<!\d)\.(?!\d)|[!?])+/g;
  const sentences: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = TERMINATOR_PATTERN.exec(text)) !== null) {
    const end = match.index + match[0].length;
    sentences.push(text.slice(lastIndex, end));
    lastIndex = end;
  }
  if (lastIndex < text.length) {
    sentences.push(text.slice(lastIndex));
  }

  return sentences;
}
