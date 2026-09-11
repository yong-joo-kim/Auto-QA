import { useState } from 'react';
import type { ProfanityMatch } from '@auto-qa/shared-types';
import { AlertOctagonIcon, CheckCircleIcon } from './icons';

interface ProfanityBadgeProps {
  detected: boolean;
  matches: ProfanityMatch[];
}

const SPEAKER_LABEL: Record<ProfanityMatch['speaker'], string> = {
  customer: '고객 발화',
  agent: '상담사 발화',
};

/** 마스킹된 비속어 구간('*' 연속)을 빨간색으로 강조해서 렌더링한다. */
function renderMaskedText(text: string) {
  const parts = text.split(/(\*+)/g);
  return parts.map((part, idx) =>
    part.startsWith('*') ? (
      <span key={idx} className="profanity-censored">
        {part}
      </span>
    ) : (
      <span key={idx}>{part}</span>
    ),
  );
}

/** FR-8: 욕설·비속어 탐지 배지. detected=true면 클릭 시 탐지 문장 목록 토글. */
export function ProfanityBadge({ detected, matches }: ProfanityBadgeProps) {
  const [open, setOpen] = useState(false);

  if (!detected) {
    return (
      <div className="profanity-row">
        <span className="profanity-toggle clear" aria-disabled="true">
          <CheckCircleIcon size={15} color="var(--success)" />
          욕설·비속어 미탐지
        </span>
      </div>
    );
  }

  return (
    <div className="profanity-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="profanity-toggle detected"
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
          aria-controls="profanity-panel"
        >
          <AlertOctagonIcon size={15} color="var(--danger)" />
          <span>욕설·비속어 탐지됨</span>
          <span style={{ opacity: 0.75, fontWeight: 400 }}>
            ({open ? '문장 숨기기' : '문장 보기'})
          </span>
        </button>
      </div>

      {open && (
        <div className="profanity-panel" id="profanity-panel">
          <div className="profanity-panel-title">감지된 욕설·비속어 문장 ({matches.length}건)</div>
          {matches.map((match, idx) => (
            <div className="profanity-match" key={idx}>
              <div className="profanity-match-speaker">{SPEAKER_LABEL[match.speaker]}</div>
              <div className="profanity-match-text">{renderMaskedText(match.maskedText)}</div>
            </div>
          ))}
          <div className="profanity-panel-note">
            자동 마스킹 처리되어 저장되었으며, 원문은 노출되지 않습니다.
          </div>
        </div>
      )}
    </div>
  );
}
