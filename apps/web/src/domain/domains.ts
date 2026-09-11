import { DOMAIN_IDS, DomainId, SUPPORTED_DOMAIN_IDS } from '@auto-qa/shared-types';

/**
 * 도메인 ID → 표시명 매핑 (seed/eval-sheets/*.json 의 domainName과 동일).
 * FR-11(다중 도메인 지원)부로 10개 도메인 전부 채점 가능하다(이전 FR-1.3의 telecom 고정 제약 해제).
 */
export const DOMAIN_NAMES: Record<DomainId, string> = {
  'finance-banking-card': '금융(은행·카드)',
  insurance: '보험',
  telecom: '통신(이동통신·인터넷)',
  'ecommerce-retail': '이커머스·유통',
  'public-service': '공공기관·민원센터',
  healthcare: '의료·헬스케어',
  'it-support': 'IT·SW 기술지원(헬프데스크)',
  'travel-lodging': '여행·숙박 예약센터',
  'delivery-o2o': '배달·O2O',
  utility: '유틸리티(전기·가스)',
};

export interface DomainOption {
  domainId: DomainId;
  domainName: string;
  enabled: boolean;
  disabledReason?: string;
}

function isSupported(domainId: DomainId): boolean {
  return (SUPPORTED_DOMAIN_IDS as DomainId[]).includes(domainId);
}

/** telecom을 최상단(기본 선택값)에, 나머지 9개 도메인을 이어서 노출한다. 10개 전부 선택 가능(FR-11). */
export const DOMAIN_OPTIONS: DomainOption[] = [
  'telecom' as DomainId,
  ...DOMAIN_IDS.filter((id) => id !== 'telecom'),
].map((domainId) => ({
  domainId,
  domainName: DOMAIN_NAMES[domainId],
  enabled: isSupported(domainId),
  disabledReason: isSupported(domainId) ? undefined : 'Phase 2 예정',
}));
