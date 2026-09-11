import { forwardRef } from 'react';
import { AlertTriangleIcon } from './icons';

interface SubmissionErrorBannerProps {
  message: string;
  onRetry: () => void;
}

export const SubmissionErrorBanner = forwardRef<HTMLDivElement, SubmissionErrorBannerProps>(
  function SubmissionErrorBanner({ message, onRetry }, ref) {
    return (
      <div className="error-banner" role="alert" ref={ref} tabIndex={-1}>
        <AlertTriangleIcon size={20} color="var(--danger)" style={{ flexShrink: 0, marginTop: 1 }} />
        <div className="error-banner-text">{message}</div>
        <button type="button" className="retry-btn" onClick={onRetry}>
          다시 시도
        </button>
      </div>
    );
  },
);
