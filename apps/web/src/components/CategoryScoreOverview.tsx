import type { CategoryScoreResult, FailedGatingItem } from '@auto-qa/shared-types';

interface CategoryScoreOverviewProps {
  categories: CategoryScoreResult[];
  failedGatingItems: FailedGatingItem[];
  itemsByCategory: Map<string, { itemId: string }[]>;
}

function categoryHasFailedGating(
  categoryId: string,
  failedGatingItems: FailedGatingItem[],
  itemsByCategory: Map<string, { itemId: string }[]>,
): boolean {
  const items = itemsByCategory.get(categoryId) ?? [];
  const failedIds = new Set(failedGatingItems.map((item) => item.itemId));
  return items.some((item) => failedIds.has(item.itemId));
}

/** 카테고리별 소계 5건을 그리드로 표시한다(FR-7.1). */
export function CategoryScoreOverview({
  categories,
  failedGatingItems,
  itemsByCategory,
}: CategoryScoreOverviewProps) {
  return (
    <div className="category-section">
      <div className="section-label">카테고리 소계</div>
      <div className="category-grid">
        {categories.map((category) => {
          const percent = category.maxScore > 0 ? (category.score / category.maxScore) * 100 : 0;
          const isFail = categoryHasFailedGating(
            category.categoryId,
            failedGatingItems,
            itemsByCategory,
          );
          return (
            <a
              className={`category-card${isFail ? ' gating-fail' : ''}`}
              href={`#category-${category.categoryId}`}
              key={category.categoryId}
            >
              <div className="category-card-name">{category.categoryName}</div>
              <div className="num category-card-score">
                {category.score}
                <span className="category-card-score-suffix"> / {category.maxScore}</span>
              </div>
              <div className="category-card-bar">
                <div
                  className="category-card-bar-fill"
                  style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
                />
              </div>
            </a>
          );
        })}
      </div>
    </div>
  );
}
