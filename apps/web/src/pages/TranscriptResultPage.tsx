import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { EvaluationItemResult, EvaluationResultResponse } from '@auto-qa/shared-types';
import { ApiError, getEvaluationResult } from '../api/client';
import { TopBar } from '../components/TopBar';
import { ProfanityBadge } from '../components/ProfanityBadge';
import { PiiBadge } from '../components/PiiBadge';
import { GatingBanner } from '../components/GatingBanner';
import { TotalScoreSummary } from '../components/TotalScoreSummary';
import { CoachingSummary } from '../components/CoachingSummary';
import { CategoryScoreOverview } from '../components/CategoryScoreOverview';
import { ItemDetailSections } from '../components/ItemDetailSections';
import { EvaluationMetaFooter } from '../components/EvaluationMetaFooter';
import { SpinnerIcon } from '../components/icons';
import { formatDateTime } from '../utils/formatDateTime';

type PageStatus = 'loading' | 'success' | 'not-found' | 'error';

function groupItemsByCategory(
  items: EvaluationItemResult[],
): Map<string, EvaluationItemResult[]> {
  const map = new Map<string, EvaluationItemResult[]>();
  for (const item of items) {
    const list = map.get(item.categoryId) ?? [];
    list.push(item);
    map.set(item.categoryId, list);
  }
  return map;
}

export function TranscriptResultPage() {
  const { id } = useParams<{ id: string }>();
  const [status, setStatus] = useState<PageStatus>('loading');
  const [result, setResult] = useState<EvaluationResultResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);

  const headingRef = useRef<HTMLHeadingElement>(null);
  const gatingBannerRef = useRef<HTMLDivElement>(null);

  const fetchResult = useCallback(async () => {
    if (!id) return;
    setStatus('loading');
    try {
      const data = await getEvaluationResult(id);
      setResult(data);
      setStatus('success');
    } catch (err) {
      if (err instanceof ApiError && err.kind === 'not-found') {
        setStatus('not-found');
      } else {
        setErrorMessage(
          err instanceof ApiError ? err.message : '결과를 불러오지 못했습니다.',
        );
        setStatus('error');
      }
    }
  }, [id]);

  useEffect(() => {
    fetchResult();
  }, [fetchResult]);

  useEffect(() => {
    if (status === 'success') {
      if (result?.gatingResult === '탈락(재검토 필요)') {
        gatingBannerRef.current?.focus();
      } else {
        headingRef.current?.focus();
      }
    }
  }, [status, result]);

  const itemsByCategory = useMemo(
    () => (result ? groupItemsByCategory(result.items) : new Map()),
    [result],
  );

  return (
    <div className="app-shell">
      <div className="app-shell-inner">
        <TopBar />

        {status === 'loading' && (
          <div className="center-state" role="status" aria-live="polite">
            <SpinnerIcon size={28} color="var(--accent)" />
            <div className="center-state-text">평가 결과를 불러오는 중입니다</div>
          </div>
        )}

        {status === 'not-found' && (
          <div className="center-state">
            <div className="center-state-title">요청하신 평가 결과를 찾을 수 없습니다</div>
            <Link className="primary-link-btn" to="/transcripts/new">
              새 평가 시작하기
            </Link>
          </div>
        )}

        {status === 'error' && (
          <div className="center-state" role="alert">
            <div className="center-state-title">결과를 불러오지 못했습니다</div>
            {errorMessage && <div className="center-state-text">{errorMessage}</div>}
            <button type="button" className="retry-btn" onClick={fetchResult}>
              다시 시도
            </button>
          </div>
        )}

        {status === 'success' && result && (
          <div className="result-page">
            <div className="result-header">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <h1 ref={headingRef} tabIndex={-1}>
                  {result.domainName} 평가 결과
                </h1>
                <div className="result-header-meta">
                  {formatDateTime(result.createdAt)} 접수 · ID {result.id}
                </div>
                {result.status === 'manual_review' && (
                  <span className="manual-review-badge" role="note">
                    ⚠ 수동 검토 필요 — 채점 값 일부가 자동 보정되었습니다
                  </span>
                )}
              </div>
              <Link className="new-eval-link" to="/transcripts/new">
                + 새 평가 시작하기
              </Link>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <ProfanityBadge detected={result.profanityDetected} matches={result.profanityMatches} />
              <PiiBadge detected={result.piiDetected} matches={result.piiMatches} />
            </div>

            <GatingBanner
              ref={gatingBannerRef}
              gatingResult={result.gatingResult}
              failedGatingItems={result.failedGatingItems}
            />

            <TotalScoreSummary
              totalScore={result.totalScore}
              totalMaxScore={result.totalMaxScore}
              grade={result.grade}
              gatingFailed={result.gatingResult === '탈락(재검토 필요)'}
            />

            <CoachingSummary goodPoints={result.goodPoints} improvements={result.improvements} />

            <CategoryScoreOverview
              categories={result.categoryScores}
              failedGatingItems={result.failedGatingItems}
              itemsByCategory={itemsByCategory}
            />

            <ItemDetailSections
              categories={result.categoryScores}
              itemsByCategory={itemsByCategory}
              evaluationId={result.id}
              onOverrideSaved={setResult}
            />

            <EvaluationMetaFooter
              evalSheetVersion={result.evalSheetVersion}
              llmProvider={result.llmProvider}
              llmModel={result.llmModel}
              sourceCitation={result.sourceCitation}
              disclaimer={result.disclaimer}
              maskingSummary={result.maskingSummary}
            />
          </div>
        )}
      </div>
    </div>
  );
}
