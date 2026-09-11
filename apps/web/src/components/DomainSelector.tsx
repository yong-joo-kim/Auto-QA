import type { DomainId } from '@auto-qa/shared-types';
import type { DomainOption } from '../domain/domains';

interface DomainSelectorProps {
  domains: DomainOption[];
  value: DomainId;
  onChange: (domainId: DomainId) => void;
  disabled: boolean;
}

/**
 * 10개 도메인 전부 선택 가능(FR-11). `domain.enabled`가 false인 항목(현재는 없음)은
 * 혹시 모를 향후 미지원 도메인을 대비해 비활성 처리 로직을 유지한다.
 */
export function DomainSelector({ domains, value, onChange, disabled }: DomainSelectorProps) {
  return (
    <div className="field-group" role="group" aria-labelledby="domain-selector-label">
      <div className="field-label" id="domain-selector-label">
        도메인
      </div>
      <div className="domain-list">
        {domains.map((domain) => {
          const isSelected = domain.domainId === value;
          const isDisabled = !domain.enabled || disabled;
          return (
            <label
              key={domain.domainId}
              className={`domain-option${isSelected ? ' selected' : ''}${
                !domain.enabled ? ' disabled' : ''
              }`}
              title={domain.disabledReason}
            >
              <input
                type="radio"
                name="domainId"
                checked={isSelected}
                disabled={isDisabled}
                aria-disabled={!domain.enabled}
                onChange={() => {
                  if (!isDisabled) onChange(domain.domainId);
                }}
              />
              <span className="domain-option-name">{domain.domainName}</span>
              {isSelected ? (
                <span className="badge-pill selected">선택됨</span>
              ) : domain.disabledReason ? (
                <span className="badge-pill muted">{domain.disabledReason}</span>
              ) : null}
            </label>
          );
        })}
      </div>
    </div>
  );
}
