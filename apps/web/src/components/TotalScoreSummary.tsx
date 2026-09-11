import type { Grade } from '@auto-qa/shared-types';

interface TotalScoreSummaryProps {
  totalScore: number;
  totalMaxScore: number;
  grade: Grade;
  gatingFailed: boolean;
}

const GRADE_CLASS: Record<Grade, string> = {
  우수: 'grade-excellent',
  양호: 'grade-good',
  보통: 'grade-fair',
  미흡: 'grade-poor',
};

export function TotalScoreSummary({
  totalScore,
  totalMaxScore,
  grade,
  gatingFailed,
}: TotalScoreSummaryProps) {
  return (
    <div className="score-summary">
      <div className="score-summary-block">
        <div className="score-summary-label">총점</div>
        <div className="num score-summary-value">
          {totalScore}
          <span className="score-summary-value-suffix"> / {totalMaxScore}</span>
        </div>
      </div>
      <div className="score-summary-divider" />
      <div className="score-summary-block">
        <div className="score-summary-label">등급</div>
        <div className="grade-row">
          <span className={`grade-pill ${GRADE_CLASS[grade]}`}>{grade}</span>
          {gatingFailed && (
            <span className="grade-caveat">게이팅 탈락으로 재검토 필요 — 등급은 참고용</span>
          )}
        </div>
      </div>
    </div>
  );
}
