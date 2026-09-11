import { LightbulbIcon, ThumbsUpIcon } from './icons';

interface CoachingSummaryProps {
  goodPoints: string[];
  improvements: string[];
}

/** FR-9: AI 코칭 요약 — "칭찬할 점"/"보완할 점"을 나란히 표시. */
export function CoachingSummary({ goodPoints, improvements }: CoachingSummaryProps) {
  return (
    <div className="coaching-section">
      <div className="section-label">AI 코칭 요약</div>
      <div className="coaching-grid">
        <div className="coaching-card good">
          <div className="coaching-card-title">
            <ThumbsUpIcon color="var(--success)" />
            칭찬할 점
          </div>
          <ul>
            {goodPoints.map((point, idx) => (
              <li key={idx}>{point}</li>
            ))}
          </ul>
        </div>
        <div className="coaching-card improve">
          <div className="coaching-card-title">
            <LightbulbIcon color="var(--amber)" />
            보완할 점
          </div>
          <ul>
            {improvements.map((point, idx) => (
              <li key={idx}>{point}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
