import { useState } from 'react';
import type { Channel } from '@auto-qa/shared-types';
import { ChevronRightIcon } from './icons';

export interface MetadataFieldsValue {
  agentId: string;
  consultedAt: string;
  channel: Channel | '';
}

interface MetadataFieldsAccordionProps {
  value: MetadataFieldsValue;
  onChange: (value: MetadataFieldsValue) => void;
}

/** FR-1의 선택 메타데이터. 채점 로직에 영향을 주지 않는다. */
export function MetadataFieldsAccordion({ value, onChange }: MetadataFieldsAccordionProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="metadata-block">
      <button
        type="button"
        className="accordion-toggle"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-controls="metadata-fields-panel"
      >
        <ChevronRightIcon
          className="accordion-chevron"
          style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
        />
        <span>메타데이터 (선택)</span>
      </button>
      {open && (
        <div id="metadata-fields-panel">
          <div className="metadata-grid">
            <div className="metadata-field">
              <label htmlFor="metadata-agent-id">상담사 ID</label>
              <input
                id="metadata-agent-id"
                type="text"
                placeholder="예: A1023"
                value={value.agentId}
                onChange={(e) => onChange({ ...value, agentId: e.target.value })}
              />
            </div>
            <div className="metadata-field">
              <label htmlFor="metadata-channel">채널</label>
              <select
                id="metadata-channel"
                value={value.channel}
                onChange={(e) =>
                  onChange({ ...value, channel: e.target.value as Channel | '' })
                }
              >
                <option value="">선택 안 함</option>
                <option value="voice">음성(Voice)</option>
                <option value="chat">채팅(Chat)</option>
              </select>
            </div>
          </div>
          <div className="metadata-note">채점 로직에는 영향을 주지 않는 참고용 필드입니다.</div>
        </div>
      )}
    </div>
  );
}
