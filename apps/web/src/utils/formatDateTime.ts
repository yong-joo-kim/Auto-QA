/** ISO8601 문자열을 한국어 로캘의 짧은 날짜/시각 문자열로 변환한다. */
export function formatDateTime(iso: string): string {
  try {
    const date = new Date(iso);
    return new Intl.DateTimeFormat('ko-KR', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date);
  } catch {
    return iso;
  }
}
