import { EvalSheet } from '@auto-qa/eval-schema';
import { buildGeminiResponseSchema, convertGeminiItemsObjectToArray } from './gemini-schema-builder';

/**
 * 순수 로직 단위 테스트(AC-2/FR-3.4 — 배점 상한·항목 완전성의 API 레벨 강제, D-2 G-2 스키마).
 * 이전까지 이 모듈은 프로바이더 스펙을 통해서만 간접적으로 커버되었고(응답 passthrough
 * 검증), 스키마 생성 자체(각 itemId에 올바른 maximum이 실리는지, 게이팅 항목만 passFail이
 * 필수인지)를 직접 검증하는 스펙이 없었다 — 이번 AC 전수 대조에서 발견한 커버리지 공백을
 * 채운다.
 */
const SHEET: EvalSheet = {
  domainId: 'test-domain',
  domainName: '테스트 도메인',
  version: '1.0.0',
  totalMaxScore: 20,
  gradeCriteria: [{ minScore: 0, grade: '보통' }],
  categories: [
    {
      categoryId: 'cat-a',
      categoryName: 'A',
      maxScore: 15,
      items: [
        { itemId: 'item-1', itemName: 'Item1', criteria: 'c1', maxScore: 4, gating: false },
        { itemId: 'item-2', itemName: 'Item2', criteria: 'c2', maxScore: 11, gating: false },
      ],
    },
    {
      categoryId: 'cat-b',
      categoryName: 'B',
      maxScore: 5,
      items: [{ itemId: 'item-3', itemName: 'Item3', criteria: 'c3', maxScore: 5, gating: true }],
    },
  ],
};

describe('buildGeminiResponseSchema', () => {
  test('각 항목의 score.maximum이 해당 항목의 maxScore와 정확히 일치한다(AC-2 배점 상한 API 레벨 강제)', () => {
    const schema = buildGeminiResponseSchema(SHEET) as {
      properties: { items: { properties: Record<string, { properties: { score: { maximum: number } } }> } };
    };
    const itemProps = schema.properties.items.properties;
    expect(itemProps['item-1'].properties.score.maximum).toBe(4);
    expect(itemProps['item-2'].properties.score.maximum).toBe(11);
    expect(itemProps['item-3'].properties.score.maximum).toBe(5);
  });

  test('items.required에 evalSheet의 모든 itemId가 포함되어 항목 누락을 강제로 차단한다(FR-3.4)', () => {
    const schema = buildGeminiResponseSchema(SHEET) as { properties: { items: { required: string[] } } };
    expect(schema.properties.items.required).toEqual(['item-1', 'item-2', 'item-3']);
  });

  test('게이팅 항목에만 passFail 속성(enum P/F)이 존재하고 required에 포함된다', () => {
    const schema = buildGeminiResponseSchema(SHEET) as {
      properties: {
        items: {
          properties: Record<
            string,
            { properties: Record<string, unknown>; required: string[] }
          >;
        };
      };
    };
    const gatingItem = schema.properties.items.properties['item-3'];
    expect(gatingItem.properties.passFail).toEqual({ type: 'STRING', enum: ['P', 'F'] });
    expect(gatingItem.required).toEqual(['score', 'reason', 'passFail']);
  });

  test('게이팅이 아닌 항목에는 passFail 속성 자체가 없다', () => {
    const schema = buildGeminiResponseSchema(SHEET) as {
      properties: { items: { properties: Record<string, { properties: Record<string, unknown>; required: string[] }> } };
    };
    const nonGatingItem = schema.properties.items.properties['item-1'];
    expect(nonGatingItem.properties.passFail).toBeUndefined();
    expect(nonGatingItem.required).toEqual(['score', 'reason']);
  });

  test('coaching 스키마는 goodPoints/improvements를 1~3개 배열로 요구한다', () => {
    const schema = buildGeminiResponseSchema(SHEET) as {
      properties: {
        coaching: {
          properties: { goodPoints: { minItems: number; maxItems: number }; improvements: { minItems: number; maxItems: number } };
          required: string[];
        };
      };
    };
    expect(schema.properties.coaching.properties.goodPoints).toMatchObject({ minItems: 1, maxItems: 3 });
    expect(schema.properties.coaching.properties.improvements).toMatchObject({ minItems: 1, maxItems: 3 });
    expect(schema.properties.coaching.required).toEqual(['goodPoints', 'improvements']);
  });

  test('D-2: additionalProperties/const 문법 요소를 사용하지 않는다(Gemini 미지원 방언 회피)', () => {
    const schema = buildGeminiResponseSchema(SHEET);
    expect(JSON.stringify(schema)).not.toContain('additionalProperties');
    expect(JSON.stringify(schema)).not.toContain('"const"');
  });

  test('profanityCheck는 스키마에 포함하지 않는다(FR-6.1 — 로컬 산출)', () => {
    const schema = buildGeminiResponseSchema(SHEET) as { properties: Record<string, unknown> };
    expect(schema.properties.profanityCheck).toBeUndefined();
  });

  test('piiCheck는 스키마에 포함하지 않는다(profanityCheck와 동일한 방식 — 로컬 산출)', () => {
    const schema = buildGeminiResponseSchema(SHEET) as { properties: Record<string, unknown> };
    expect(schema.properties.piiCheck).toBeUndefined();
  });
});

describe('convertGeminiItemsObjectToArray', () => {
  test('itemId-key 객체를 evalSheet 항목 순서대로 배열로 변환한다', () => {
    const result = convertGeminiItemsObjectToArray(
      {
        'item-3': { score: 5, reason: 'r3', passFail: 'P' },
        'item-1': { score: 4, reason: 'r1' },
        'item-2': { score: 3, reason: 'r2' },
      },
      SHEET,
    );
    expect(result.map((i) => i.itemId)).toEqual(['item-1', 'item-2', 'item-3']);
  });

  test('FR-5.3: 응답에 없는 itemId는 만들어내지 않는다(누락은 그대로 누락으로 남음)', () => {
    const result = convertGeminiItemsObjectToArray({ 'item-1': { score: 4, reason: 'r1' } }, SHEET);
    expect(result).toHaveLength(1);
    expect(result[0].itemId).toBe('item-1');
  });

  test('FR-5.5: evalSheet에 없는 미지 itemId도 제거하지 않고 그대로 포함한다', () => {
    const result = convertGeminiItemsObjectToArray(
      {
        'item-1': { score: 4, reason: 'r1' },
        'item-2': { score: 3, reason: 'r2' },
        'item-3': { score: 5, reason: 'r3', passFail: 'P' },
        'unknown-item': { score: 1, reason: 'r4' },
      },
      SHEET,
    );
    expect(result.map((i) => i.itemId)).toContain('unknown-item');
    expect(result).toHaveLength(4);
  });

  test('FR-5.2: 계약 외 필드가 섞여 있어도 제거하지 않고 그대로 전달한다', () => {
    const result = convertGeminiItemsObjectToArray(
      { 'item-1': { score: 4, reason: 'r1', overridden: true } },
      SHEET,
    );
    expect(result[0]).toMatchObject({ itemId: 'item-1', score: 4, reason: 'r1', overridden: true });
  });

  test('itemsObj가 null/배열/원시값이면 빈 객체로 취급해 모든 itemId가 누락 처리된다', () => {
    expect(convertGeminiItemsObjectToArray(null, SHEET)).toHaveLength(0);
    expect(convertGeminiItemsObjectToArray([1, 2, 3], SHEET)).toHaveLength(0);
    expect(convertGeminiItemsObjectToArray('not-an-object', SHEET)).toHaveLength(0);
  });
});
