import { z } from 'zod';
import { EvalSheet, listItemIds } from '@auto-qa/eval-schema';

/**
 * 요청마다 동적으로 생성되는 구조화 출력(JSON Schema).
 *
 * CLAUDE.md 핵심 설계 원칙: "평가시트별 항목 배점이 다르므로, Claude API 구조화 출력
 * 스키마를 요청마다 동적으로 생성하고 각 item.score에 maximum: <해당 항목 배점>을
 * 지정해 배점 초과를 API 레벨에서 차단한다."
 *
 * Phase 1은 mock 프로바이더만 실제로 사용하지만(anthropic/gemini는 스텁), 향후
 * AnthropicLlmEvaluationProvider/GeminiLlmEvaluationProvider가 tool-use / structured
 * output 요청을 만들 때 이 함수가 반환하는 스키마를 input_schema로 사용해야 한다.
 */
export function buildEvaluationResponseJsonSchema(evalSheet: EvalSheet): Record<string, unknown> {
  const itemSchemas = evalSheet.categories.flatMap((category) =>
    category.items.map((item) => ({
      type: 'object',
      properties: {
        itemId: { const: item.itemId },
        score: {
          type: 'integer',
          minimum: 0,
          // 항목별 배점을 그대로 maximum으로 지정 → 배점 초과 응답을 API 레벨에서 차단
          maximum: item.maxScore,
        },
        reason: { type: 'string', minLength: 1 },
        ...(item.gating
          ? { passFail: { type: 'string', enum: ['P', 'F'] } }
          : {}),
      },
      required: item.gating
        ? ['itemId', 'score', 'reason', 'passFail']
        : ['itemId', 'score', 'reason'],
      additionalProperties: false,
    })),
  );

  return {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        minItems: itemSchemas.length,
        maxItems: itemSchemas.length,
        items: { anyOf: itemSchemas },
      },
      coaching: {
        type: 'object',
        properties: {
          goodPoints: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: 3,
          },
          improvements: {
            type: 'array',
            items: { type: 'string' },
            minItems: 1,
            maxItems: 3,
          },
        },
        required: ['goodPoints', 'improvements'],
        additionalProperties: false,
      },
      profanityCheck: {
        type: 'object',
        properties: {
          detected: { type: 'boolean' },
          matches: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                speaker: { type: 'string', enum: ['customer', 'agent'] },
                maskedText: { type: 'string' },
              },
              required: ['speaker', 'maskedText'],
              additionalProperties: false,
            },
          },
        },
        required: ['detected', 'matches'],
        additionalProperties: false,
      },
      piiCheck: {
        type: 'object',
        properties: {
          detected: { type: 'boolean' },
          matches: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                speaker: { type: 'string', enum: ['customer', 'agent'] },
                maskedText: { type: 'string' },
              },
              required: ['speaker', 'maskedText'],
              additionalProperties: false,
            },
          },
        },
        required: ['detected', 'matches'],
        additionalProperties: false,
      },
    },
    required: ['items', 'coaching', 'profanityCheck', 'piiCheck'],
    additionalProperties: false,
  };
}

/**
 * 실제 LLM 응답(runtime)을 검증하는 zod 스키마.
 *
 * H-2: coaching/profanityCheck 필드가 전혀 검증되지 않아 누락 시 TypeError(500)로 죽는 문제를
 * 해결하기 위해, §4.2 계약(구조적 위반 → 502) 검증을 이 스키마 하나로 통합한다.
 * `buildEvaluationResponseJsonSchema`와 동일한 구조적 계약을 대상으로 하되, 이 스키마는
 * "값 범위 위반"(score 범위/정수/reason 공백 등, NFR-3.3의 재시도→clamp 대상)은 검사하지 않는다
 * — 그 부분은 `evaluation.service.ts`의 validateScoreRanges가 별도로 담당한다(관심사 분리).
 */
export function buildLlmResponseZodSchema(evalSheet: EvalSheet) {
  const expectedItemIds = new Set(listItemIds(evalSheet));

  // 항목 단위로는 itemId만 구조적으로 검증한다(itemId 집합 매칭에 필요한 최소 요건).
  // score/reason/passFail의 타입·범위·필수여부는 값 범위 위반(NFR-3.3)이므로 여기서 강제하지
  // 않는다 — 누락/문자열 score, 빈 reason, 잘못된 passFail 값은 evaluation.service.ts의
  // validateScoreRanges가 담당해 "재시도 → clamp → manual_review" 경로로 처리한다(H-1, M-1, M-2).
  //
  // N-1(재리뷰 round2): `.passthrough()`였던 시절에는 LLM 응답이 originalScore/overridden/
  // overrideNote/overrideReviewer/overriddenAt 같은 감사 추적 전용 필드(FR-10, 오직 사람이
  // 수행하는 TranscriptsService.overrideItemScore 경로에서만 채워져야 함)를 위조해 실어 보내도
  // 그대로 통과되어 DB에 저장될 수 있었다. `buildEvaluationResponseJsonSchema`가 이미
  // `additionalProperties: false`로 이 필드들을 차단하고 있으므로, 런타임 zod 계약도 동일하게
  // `.strict()`로 맞춰 두 계약을 일치시킨다 — itemId/score/reason/passFail 외 필드가 하나라도
  // 있으면 구조적 계약 위반(502, 저장 안 됨)으로 처리한다.
  const itemResultSchema = z
    .object({
      itemId: z.string(),
      score: z.unknown().optional(),
      reason: z.unknown().optional(),
      passFail: z.unknown().optional(),
    })
    .strict();

  return z
    .object({
      items: z.array(itemResultSchema),
      providerMeta: z.object({
        provider: z.string(),
        model: z.string(),
        latencyMs: z.number(),
      }),
      // FR-9: 칭찬할 점/보완할 점 각 1~3개의 비어있지 않은 문자열
      coaching: z.object({
        goodPoints: z.array(z.string().min(1)).min(1).max(3),
        improvements: z.array(z.string().min(1)).min(1).max(3),
      }),
      // FR-8: 탐지 여부(boolean) + 탐지 시 화자 구분된 매치 목록
      profanityCheck: z.object({
        detected: z.boolean(),
        matches: z.array(
          z.object({
            speaker: z.enum(['customer', 'agent']),
            maskedText: z.string(),
          }),
        ),
      }),
      // PII 마스킹 알림(profanityCheck와 동일한 방식, PM 요청 2026-09-13): 탐지 여부 +
      // 탐지 시 화자 구분된 매치 목록(placeholder로 치환된 문장만 포함)
      piiCheck: z.object({
        detected: z.boolean(),
        matches: z.array(
          z.object({
            speaker: z.enum(['customer', 'agent']),
            maskedText: z.string(),
          }),
        ),
      }),
    })
    .superRefine((data, ctx) => {
      const gotIds = data.items.map((i) => i.itemId);
      const gotIdSet = new Set(gotIds);

      if (gotIds.length !== gotIdSet.size) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: '중복된 itemId가 포함되어 있습니다.' });
      }
      for (const id of expectedItemIds) {
        if (!gotIdSet.has(id)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `누락된 itemId: ${id}` });
        }
      }
      for (const id of gotIdSet) {
        if (!expectedItemIds.has(id)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `평가시트에 존재하지 않는 itemId: ${id}`,
          });
        }
      }
      if (data.profanityCheck.detected && data.profanityCheck.matches.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'profanityCheck.detected가 true이면 matches가 1건 이상이어야 합니다.',
        });
      }
      if (data.piiCheck.detected && data.piiCheck.matches.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'piiCheck.detected가 true이면 matches가 1건 이상이어야 합니다.',
        });
      }
    });
}
