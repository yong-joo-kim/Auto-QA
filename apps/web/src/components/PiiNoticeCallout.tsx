import { InfoIcon } from './icons';

/** NFR-1.3 고지: 정규식 기반 마스킹으로 100% 탐지를 보장하지 않음을 안내. */
export function PiiNoticeCallout() {
  return (
    <div className="pii-notice">
      <InfoIcon color="var(--text-muted)" style={{ flexShrink: 0, marginTop: 1 }} />
      <div className="pii-notice-text">
        전화번호·이메일·주민등록번호·카드번호 등은 자동 마스킹 후 저장/전송됩니다.
        <br />
        단, 정규식 기반 탐지로 100% 탐지를 보장하지 않습니다.
      </div>
    </div>
  );
}
