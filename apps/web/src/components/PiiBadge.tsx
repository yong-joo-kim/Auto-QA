import { useState } from 'react';
import type { PiiMatch } from '@auto-qa/shared-types';
import { AlertOctagonIcon, CheckCircleIcon } from './icons';

interface PiiBadgeProps {
  detected: boolean;
  matches: PiiMatch[];
}

const SPEAKER_LABEL: Record<PiiMatch['speaker'], string> = {
  customer: '고객 발화',
  agent: '상담사 발화',
};

/** 마스킹된 개인정보 구간(대괄호 placeholder, 예: "[전화번호]")을 강조해서 렌더링한다. */
function renderMaskedText(text: string) {
  const parts = text.split(/(\[(?:주민등록번호|전화번호|카드번호|계좌번호|이메일)\])/g);
  return parts.map((part, idx) =>
    part.startsWith('[') ? (
      <span key={idx} className="pii-censored">
        {part}
      </span>
    ) : (
      <span key={idx}>{part}</span>
    ),
  );
}

/** 개인정보(PII) 마스킹 알림 배지. 비속어 배지(ProfanityBadge)와 동일한 방식으로,
 * detected=true면 클릭 시 탐지 문장 목록을 토글한다. */
export function PiiBadge({ detected, matches }: PiiBadgeProps) {
  const [open, setOpen] = useState(false);

  if (!detected) {
    return (
      <div className="pii-row">
        <span className="pii-toggle clear" aria-disabled="true">
          <CheckCircleIcon size={15} color="var(--success)" />
          개인정보 미탐지
        </span>
      </div>
    );
  }

  return (
    <div className="pii-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="pii-toggle detected"
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
          aria-controls="pii-panel"
        >
          <AlertOctagonIcon size={15} color="var(--amber)" />
          <span>개인정보 탐지됨</span>
          <span style={{ opacity: 0.75, fontWeight: 400 }}>
            ({open ? '문장 숨기기' : '문장 보기'})
          </span>
        </button>
      </div>

      {open && (
        <div className="pii-panel" id="pii-panel">
          <div className="pii-panel-title">감지된 개인정보 포함 문장 ({matches.length}건)</div>
          {matches.map((match, idx) => (
            <div className="pii-match" key={idx}>
              <div className="pii-match-speaker">{SPEAKER_LABEL[match.speaker]}</div>
              <div className="pii-match-text">{renderMaskedText(match.maskedText)}</div>
            </div>
          ))}
          <div className="pii-panel-note">
            자동 마스킹 처리되어 저장되었으며, 원문은 노출되지 않습니다.
          </div>
        </div>
      )}
    </div>
  );
}
