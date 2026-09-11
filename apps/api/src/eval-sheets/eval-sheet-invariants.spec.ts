import { evalSheetSchema, loadEvalSheet, listSupportedDomainIds } from '@auto-qa/eval-schema';

/**
 * 회귀 테스트 대상: packages/eval-schema/src/schema.ts (evalSheetSchema, loadEvalSheet)
 * 참고: docs/review/phase1-vertical-slice-review-round2.md — M-6(배점 합계 불변식) 해소 확인,
 * test-automation 인계 사항("평가시트 불변식: seed 10종 통과 + 변조 3종 거부").
 */

describe('seed/eval-sheets/*.json 10종 로딩', () => {
  test('지원 도메인은 10개다', () => {
    expect(listSupportedDomainIds()).toHaveLength(10);
  });

  test.each(listSupportedDomainIds())('%s 평가시트가 정상 로드되고 배점 불변식을 만족한다', (domainId) => {
    const sheet = loadEvalSheet(domainId);

    expect(sheet.domainId).toBe(domainId);
    expect(sheet.categories.length).toBeGreaterThan(0);

    const categoryMaxScoreSum = sheet.categories.reduce((sum, c) => sum + c.maxScore, 0);
    expect(categoryMaxScoreSum).toBe(sheet.totalMaxScore);

    for (const category of sheet.categories) {
      const itemMaxScoreSum = category.items.reduce((sum, i) => sum + i.maxScore, 0);
      expect(itemMaxScoreSum).toBe(category.maxScore);
    }
  });
});

describe('평가시트 배점 불변식 위반 시 거부(M-6 회귀 방지)', () => {
  /** items 합/category 합/totalMaxScore가 모두 정합된 최소 유효 시트. */
  function buildValidSheet() {
    return {
      domainId: 'test-domain',
      domainName: '테스트 도메인',
      version: '1.0.0',
      totalMaxScore: 20,
      gradeCriteria: [
        { minScore: 90, grade: '우수' },
        { minScore: 0, grade: '미흡' },
      ],
      categories: [
        {
          categoryId: 'cat-a',
          categoryName: 'A',
          maxScore: 10,
          items: [
            { itemId: 'item-1', itemName: 'Item1', criteria: 'c1', maxScore: 5, gating: false },
            { itemId: 'item-2', itemName: 'Item2', criteria: 'c2', maxScore: 5, gating: false },
          ],
        },
        {
          categoryId: 'cat-b',
          categoryName: 'B',
          maxScore: 10,
          items: [{ itemId: 'item-3', itemName: 'Item3', criteria: 'c3', maxScore: 10, gating: true }],
        },
      ],
    };
  }

  test('대조군: 정상 시트는 통과한다', () => {
    const result = evalSheetSchema.safeParse(buildValidSheet());
    expect(result.success).toBe(true);
  });

  test('변조 1 — 카테고리 내 item.maxScore 합이 category.maxScore와 불일치하면 거부된다', () => {
    const sheet = buildValidSheet();
    sheet.categories[0].items[0].maxScore = 999; // item 합(999+5=1004) !== category.maxScore(10)

    const result = evalSheetSchema.safeParse(sheet);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'categories.0.maxScore')).toBe(true);
    }
  });

  test('변조 2 — 전체 category.maxScore 합이 totalMaxScore와 불일치하면 거부된다', () => {
    const sheet = buildValidSheet();
    sheet.totalMaxScore = 999; // categories 합(20) !== totalMaxScore(999), 카테고리 내부는 정합 유지

    const result = evalSheetSchema.safeParse(sheet);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.join('.') === 'totalMaxScore')).toBe(true);
    }
  });

  test('변조 3 — category.maxScore만 증가시키면(items/totalMaxScore 미조정) 거부된다', () => {
    const sheet = buildValidSheet();
    sheet.categories[0].maxScore += 10; // items 합(10) !== category.maxScore(20), 전체 합도 불일치

    const result = evalSheetSchema.safeParse(sheet);

    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths).toEqual(expect.arrayContaining(['categories.0.maxScore', 'totalMaxScore']));
    }
  });
});
