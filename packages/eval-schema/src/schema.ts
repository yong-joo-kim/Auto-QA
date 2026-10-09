import { z } from 'zod';

/**
 * 평가시트(Evaluation Sheet) zod 스키마.
 * 참고: docs/architecture/eval-sheet-schema.md, seed/eval-sheets/*.json
 */

/**
 * 길이 상한(M-8): 평가시트 문구는 LLM 프롬프트에 그대로 들어가므로, 업로드/직접 편집으로
 * 프롬프트가 비대해지거나 토큰 한도를 넘지 않도록 제한한다(seed 최대값 대비 충분한 여유).
 */
export const MAX_NAME_LENGTH = 100;
export const MAX_CRITERIA_LENGTH = 1000;
export const MAX_META_LENGTH = 500;
export const MAX_DISCLAIMER_LENGTH = 1000;

export const evalItemSchema = z.object({
  itemId: z.string().min(1),
  itemName: z.string().min(1).max(MAX_NAME_LENGTH),
  criteria: z.string().min(1).max(MAX_CRITERIA_LENGTH),
  maxScore: z.number().int().positive(),
  gating: z.boolean(),
});
export type EvalItem = z.infer<typeof evalItemSchema>;

export const evalCategorySchema = z.object({
  categoryId: z.string().min(1),
  categoryName: z.string().min(1).max(MAX_NAME_LENGTH),
  maxScore: z.number().int().positive(),
  items: z.array(evalItemSchema).min(1),
});
export type EvalCategory = z.infer<typeof evalCategorySchema>;

export const gradeCriterionSchema = z.object({
  minScore: z.number().int().nonnegative(),
  grade: z.string().min(1),
});
export type GradeCriterion = z.infer<typeof gradeCriterionSchema>;

const evalSheetBaseSchema = z.object({
  domainId: z.string().min(1),
  domainName: z.string().min(1).max(MAX_NAME_LENGTH),
  version: z.string().min(1),
  mainConsultationTypes: z.string().max(MAX_META_LENGTH).optional(),
  totalMaxScore: z.number().int().positive(),
  gradeCriteria: z.array(gradeCriterionSchema).min(1),
  gatingPolicy: z.string().max(MAX_DISCLAIMER_LENGTH).optional(),
  categories: z.array(evalCategorySchema).min(1),
  sourceCitation: z.string().max(MAX_META_LENGTH).optional(),
  disclaimer: z.string().max(MAX_DISCLAIMER_LENGTH).optional(),
});

/**
 * 배점 무결성 불변식(M-6, 회귀 방지용):
 *  - 카테고리 내 items.maxScore 합 === category.maxScore
 *  - 전체 category.maxScore 합 === totalMaxScore
 * seed/eval-sheets/*.json 10종은 이미 정합이므로 정상 로드 시 실패하지 않아야 한다.
 */
export const evalSheetSchema = evalSheetBaseSchema.superRefine((sheet, ctx) => {
  let categoryMaxScoreSum = 0;

  sheet.categories.forEach((category, categoryIndex) => {
    const itemMaxScoreSum = category.items.reduce((sum, item) => sum + item.maxScore, 0);
    categoryMaxScoreSum += category.maxScore;

    if (itemMaxScoreSum !== category.maxScore) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['categories', categoryIndex, 'maxScore'],
        message: `카테고리(${category.categoryId})의 items.maxScore 합(${itemMaxScoreSum})이 category.maxScore(${category.maxScore})와 일치하지 않습니다.`,
      });
    }
  });

  if (categoryMaxScoreSum !== sheet.totalMaxScore) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['totalMaxScore'],
      message: `전체 category.maxScore 합(${categoryMaxScoreSum})이 totalMaxScore(${sheet.totalMaxScore})와 일치하지 않습니다.`,
    });
  }
});
export type EvalSheet = z.infer<typeof evalSheetBaseSchema>;

/** 평가시트 내 모든 itemId 목록 (중복 없이) */
export function listItemIds(sheet: EvalSheet): string[] {
  return sheet.categories.flatMap((c) => c.items.map((i) => i.itemId));
}

/** itemId -> { item, category } 조회용 맵 생성 */
export function indexItems(
  sheet: EvalSheet,
): Map<string, { item: EvalItem; category: EvalCategory }> {
  const map = new Map<string, { item: EvalItem; category: EvalCategory }>();
  for (const category of sheet.categories) {
    for (const item of category.items) {
      map.set(item.itemId, { item, category });
    }
  }
  return map;
}

/** 게이팅 항목(itemId)만 필터링 */
export function listGatingItemIds(sheet: EvalSheet): string[] {
  return sheet.categories.flatMap((c) =>
    c.items.filter((i) => i.gating).map((i) => i.itemId),
  );
}

/** totalScore를 gradeCriteria(내림차순 minScore)에 대입해 등급 산출 */
export function resolveGrade(totalScore: number, sheet: EvalSheet): string {
  const sorted = [...sheet.gradeCriteria].sort((a, b) => b.minScore - a.minScore);
  const matched = sorted.find((c) => totalScore >= c.minScore);
  return matched ? matched.grade : sorted[sorted.length - 1].grade;
}
