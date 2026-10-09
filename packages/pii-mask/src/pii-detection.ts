/**
 * 개인정보(PII) 마스킹 알림 — 비속어 탐지(`profanity.ts`)와 동일한 방식으로, 이미 마스킹이
 * 끝난 상담 텍스트에서 "PII placeholder가 포함된 문장"만 화자와 함께 골라 반환한다(PM 요청,
 * 2026-09-13 — 비속어 알림과 동일한 Green/Red 배지 + 클릭 시 해당 문장만 노출).
 *
 * `maskPii`(mask.ts)가 이미 원문 PII를 `[전화번호]` 등 고정 placeholder로 치환해 두므로, 이
 * 시점에는 원문 PII 자체가 존재하지 않는다 — 여기서는 그 placeholder가 어느 문장에 남아있는지
 * 문장 단위로 찾아내는 역할만 한다(원문 유추 불가, 종류 자체도 노출하지 않고 문장 그대로 반환).
 * 다만 그 문장에 비속어가 우연히 함께 있으면(`maskPii`는 PII만 다루고 비속어는 건드리지 않음)
 * `profanity.ts`의 마스킹 로직을 재사용해 함께 `***` 처리한다 — PII 배지에서도 원문 욕설이
 * 그대로 노출되지 않아야 하기 때문이다.
 *
 * 화자 접두어 파싱 + 문장 분리는 `transcript-utils.ts`를 통해 `profanity.ts`와 로직을 공유한다.
 */

import { PII_PLACEHOLDERS } from './mask';
import { maskProfanityInSentence } from './profanity';
import { parseSpeakerLines, splitIntoSentences, Speaker } from './transcript-utils';

export interface PiiMatch {
  speaker: Speaker;
  /** PII 원문이 아니라 placeholder(예: "[전화번호]")로 치환된 문장만 포함 */
  maskedText: string;
}

export interface PiiCheckResult {
  detected: boolean;
  matches: PiiMatch[];
}

/** PII_PLACEHOLDERS의 값 중 하나라도 문장에 등장하면 매치로 간주한다. 정규식 특수문자가
 * 포함되지 않은 한글 대괄호 문자열만 다루므로 별도 escape 없이 안전하게 결합할 수 있다. */
const PII_PLACEHOLDER_PATTERN = new RegExp(
  Object.values(PII_PLACEHOLDERS)
    .map((placeholder) => placeholder.replace(/[[\]]/g, '\\$&'))
    .join('|'),
);

/** L-3(profanity.ts와 동일 근거): 문장부호가 비정상적으로 밀집된 입력에서 matches 배열이
 * 과도하게 커지는 것을 막기 위한 상한. */
const MAX_PII_MATCHES = 500;

/** 이미 PII 마스킹이 끝난 텍스트(maskedTranscript)에서, PII placeholder가 포함된 문장만
 * 화자와 함께 반환한다. PII가 없는 문장은 결과에 포함되지 않는다(전체 대화 미노출, 비속어
 * 탐지와 동일한 원칙). */
export function detectPii(maskedTranscript: string): PiiCheckResult {
  const lines = parseSpeakerLines(maskedTranscript);
  const matches: PiiMatch[] = [];

  outer: for (const line of lines) {
    for (const rawSentence of splitIntoSentences(line.text)) {
      const sentence = rawSentence.trim();
      if (sentence.length === 0) continue;
      if (!PII_PLACEHOLDER_PATTERN.test(sentence)) continue;

      // 이 문장에 비속어가 우연히 함께 있어도 원문 욕설이 화면에 노출되지 않도록 함께 마스킹한다
      // (비속어 배지와 동일한 "화면에 원문 욕설을 남기지 않는다" 원칙 — PII 배지에도 적용).
      matches.push({ speaker: line.speaker, maskedText: maskProfanityInSentence(sentence) });
      if (matches.length >= MAX_PII_MATCHES) break outer;
    }
  }

  return { detected: matches.length > 0, matches };
}
