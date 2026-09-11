export function TopBar() {
  return (
    <div className="top-bar">
      <div className="top-bar-logo">
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="white"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M9 12l2 2 4-4" />
          <circle cx="12" cy="12" r="9" />
        </svg>
      </div>
      <div className="top-bar-title">Auto QA</div>
      <div className="top-bar-divider" />
      <div className="top-bar-subtitle">콜센터 상담 자동평가</div>
    </div>
  );
}
