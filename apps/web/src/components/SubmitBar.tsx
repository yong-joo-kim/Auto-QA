import { SpinnerIcon } from './icons';

interface SubmitBarProps {
  loading: boolean;
  disabled: boolean;
  onSubmit: () => void;
}

export function SubmitBar({ loading, disabled, onSubmit }: SubmitBarProps) {
  return (
    <div className="submit-bar">
      {loading && (
        <div className="submit-loading-indicator" role="status" aria-live="polite">
          <SpinnerIcon color="var(--accent)" />
          채점 진행 중입니다 (수 초 소요될 수 있습니다)
        </div>
      )}
      <button
        type="button"
        className="submit-btn"
        onClick={onSubmit}
        disabled={disabled}
        aria-busy={loading}
      >
        {loading ? '채점 진행 중...' : '채점 요청'}
      </button>
    </div>
  );
}
