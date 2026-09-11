import { forwardRef } from 'react';
import type { FailedGatingItem, GatingResult } from '@auto-qa/shared-types';
import { AlertTriangleIcon, CheckCircleIcon } from './icons';

interface GatingBannerProps {
  gatingResult: GatingResult;
  failedGatingItems: FailedGatingItem[];
}

/**
 * 최상단, 가장 눈에 띄는 요소. 총점보다 먼저 표시하여
 * "총점이 높아도 탈락일 수 있다"는 오해를 방지한다(요구사항 §3, UI 설계서 §3.2).
 */
export const GatingBanner = forwardRef<HTMLDivElement, GatingBannerProps>(function GatingBanner(
  { gatingResult, failedGatingItems },
  ref,
) {
  const isFail = gatingResult === '탈락(재검토 필요)';

  return (
    <div
      className={`gating-banner ${isFail ? 'fail' : 'pass'}`}
      role={isFail ? 'alert' : undefined}
      aria-live={isFail ? 'assertive' : undefined}
      ref={ref}
      tabIndex={-1}
    >
      <div className="gating-banner-icon">
        {isFail ? (
          <AlertTriangleIcon size={26} color="var(--danger)" />
        ) : (
          <CheckCircleIcon size={26} color="var(--success)" />
        )}
      </div>
      <div className="gating-banner-body">
        <div className="gating-banner-title">{gatingResult}</div>
        {isFail && failedGatingItems.length > 0 && (
          <div className="gating-banner-detail">
            게이팅 실패 항목:{' '}
            {failedGatingItems.map((item, idx) => (
              <span key={item.itemId}>
                <strong>{item.itemName}</strong>{' '}
                <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>({item.itemId})</span>
                {idx < failedGatingItems.length - 1 ? ', ' : ''}
              </span>
            ))}
          </div>
        )}
        <div className="gating-banner-footnote">
          ※ 게이팅 탈락 시 총점·등급과 무관하게 재검토가 필요합니다.
        </div>
      </div>
    </div>
  );
});
