import { EvalSheet, listItemIds } from '@auto-qa/eval-schema';

/**
 * Gemini 전용 구조화 출력(responseSchema) 빌더 (D-2, FR-3.2~3.4).
 *
 * `schema-builder.ts`(Anthropic/일반 JSON Schema 방언)와 달리 Gemini의 responseSchema는
 * OpenAPI 3.0 서브셋을 사용하며 다음을 지원하지 않는다(2026-09-12 실호출로 확인됨):
 *  - `const` (필드 값 고정)
 *  - `additionalProperties`
 *  - 배열 요소별 서로 다른 스키마를 표현하는 `anyOf`(요소 스키마 자체는 지원하되, 항목별로
 *    다른 `maximum`을 배열 스키마 하나로 표현할 수 없음)
 *
 * 반대로 다음은 실호출로 지원이 확인되었다:
 *  - `enum`(단일값 enum으로 `const`를 대체 가능)
 *  - `minimum`/`maximum`/`minLength`/`minItems`/`maxItems`
 *  - 중첩 객체 스키마, 필드마다 다른 `required`
 *
 * 따라서 FR-3.4(G-2 권고)에 따라 items를 배열이 아니라 **itemId를 property key로 하는 객체**로
 * 요청한다. 각 key의 score에 해당 항목의 maxScore를 `maximum`으로 직접 지정할 수 있어
 * `const`/`anyOf` 없이도 배점 상한을 API 레벨에서 강제할 수 있고, itemId 누락도 객체
 * `required`로 강제된다.
 *
 * profanityCheck는 요청하지 않는다(FR-6.1 — 로컬 detectProfanity로 산출, LLM에 위임하지 않음).
 */
export function buildGeminiResponseSchema(evalSheet: EvalSheet): Record<string, unknown> {
  const itemIds = listItemIds(evalSheet);
  const itemProperties: Record<string, unknown> = {};

  for (const category of evalSheet.categories) {
    for (const item of category.items) {
      itemProperties[item.itemId] = {
        type: 'OBJECT',
        properties: {
          score: {
            type: 'INTEGER',
            minimum: 0,
            // 항목별 배점을 그대로 maximum으로 지정 → 배점 초과 응답을 API 레벨에서 차단
            maximum: item.maxScore,
          },
          reason: { type: 'STRING', minLength: 1 },
          ...(item.gating ? { passFail: { type: 'STRING', enum: ['P', 'F'] } } : {}),
        },
        required: item.gating ? ['score', 'reason', 'passFail'] : ['score', 'reason'],
      };
    }
  }

  return {
    type: 'OBJECT',
    properties: {
      items: {
        type: 'OBJECT',
        properties: itemProperties,
        required: itemIds,
      },
      coaching: {
        type: 'OBJECT',
        properties: {
          goodPoints: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            minItems: 1,
            maxItems: 3,
          },
          improvements: {
            type: 'ARRAY',
            items: { type: 'STRING' },
            minItems: 1,
            maxItems: 3,
          },
        },
        required: ['goodPoints', 'improvements'],
      },
    },
    required: ['items', 'coaching'],
  };
}

/**
 * Gemini가 반환한 "itemId를 key로 하는 객체" 형태를 `LlmItemResult[]` 배열로 변환한다.
 *
 * FR-5.1/5.2("최소 파싱" 원칙)을 지키기 위해 이 함수는 **형태 변환만** 수행하고 값을
 * 검증·보정하지 않는다:
 *  - evalSheet에 존재하는 itemId 중 응답에 없는 것은 만들어내지 않는다(FR-5.3) — 결과적으로
 *    누락된 itemId는 배열에서 빠지고, 이는 EvaluationService가 502로 거부한다(의도된 동작).
 *  - 각 항목의 score/reason/passFail 외의 계약 외 필드가 섞여 있어도 제거하지 않고 그대로
 *    전달한다(FR-5.5) — zod `.strict()`가 이를 502로 차단하는 것이 설계 의도다.
 *  - evalSheet에 없는 미지 itemId가 응답에 섞여 있어도 그대로 포함한다(구조 위반 검증에서
 *    502로 처리됨).
 */
export function convertGeminiItemsObjectToArray(
  itemsObj: unknown,
  evalSheet: EvalSheet,
): Array<Record<string, unknown>> {
  const source: Record<string, unknown> =
    itemsObj !== null && typeof itemsObj === 'object' && !Array.isArray(itemsObj)
      ? (itemsObj as Record<string, unknown>)
      : {};

  const knownItemIds = listItemIds(evalSheet);
  const seen = new Set<string>();
  const items: Array<Record<string, unknown>> = [];

  for (const itemId of knownItemIds) {
    if (Object.prototype.hasOwnProperty.call(source, itemId)) {
      const value = source[itemId];
      const base = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
      items.push({ ...base, itemId });
      seen.add(itemId);
    }
  }

  // evalSheet에 없는 itemId가 섞여 있어도 삭제하지 않고 그대로 전달한다(구조 위반 검증이 502로
  // 처리하도록 위임 — FR-5.5와 동일한 취지).
  for (const [itemId, value] of Object.entries(source)) {
    if (seen.has(itemId)) continue;
    const base = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    items.push({ ...base, itemId });
  }

  return items;
}
