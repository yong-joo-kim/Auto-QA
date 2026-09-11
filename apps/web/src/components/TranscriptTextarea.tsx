import { countNonWhitespace } from '@auto-qa/shared-types';

interface TranscriptTextareaProps {
  value: string;
  onChange: (value: string) => void;
  minLength: number;
  errorMessage?: string;
  disabled: boolean;
}

export function TranscriptTextarea({
  value,
  onChange,
  minLength,
  errorMessage,
  disabled,
}: TranscriptTextareaProps) {
  const trimmedLen = countNonWhitespace(value);
  const hasError = Boolean(errorMessage);

  return (
    <div className="field-group">
      <label className="field-label" htmlFor="transcript-textarea">
        상담대화 트랜스크립트 <span style={{ color: 'var(--accent)' }}>*</span>{' '}
        <span style={{ fontWeight: 500, color: 'var(--text-faint)' }}>(필수)</span>
      </label>
      <textarea
        id="transcript-textarea"
        className="transcript-textarea"
        rows={8}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={hasError}
        aria-describedby={hasError ? 'transcript-error' : 'transcript-char-count'}
        disabled={disabled}
        placeholder="상담사: 안녕하세요, OO 상담원입니다. 무엇을 도와드릴까요?&#10;고객: 네, 문의드릴 게 있어서요..."
      />
      {hasError && (
        <div className="field-error" id="transcript-error" role="alert">
          <span aria-hidden="true">⚠</span> {errorMessage}
        </div>
      )}
      <div className="char-count-row" id="transcript-char-count">
        <span>
          공백 제외 {trimmedLen}자 / 최소 {minLength}자
        </span>
      </div>
    </div>
  );
}
