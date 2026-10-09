import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import {
  downloadEvalSheet,
  downloadEvalSheets,
  getEvalSheetDetail,
  listEvalSheets,
  resetEvalSheet,
  UploadValidationError,
  uploadEvalSheets,
  type EvalSheetDetail,
  type EvalSheetSummary,
  type UploadEvalSheetsResult,
} from '../api/client';
import { TopBar } from '../components/TopBar';

const EvalSheetDetailPanel = forwardRef<
  HTMLElement,
  { sheet: EvalSheetDetail; onClose: () => void }
>(function EvalSheetDetailPanel({ sheet, onClose }, ref) {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string>();

  async function onDownload() {
    setDownloading(true);
    setDownloadError(undefined);
    try {
      await downloadEvalSheet(sheet.domainId);
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : '평가시트를 다운로드하지 못했습니다.');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <section ref={ref} className="sheet-detail" aria-label={`${sheet.domainName} 평가시트 정의`}>
      <div className="sheet-detail-header">
        <div>
          <h2>{sheet.domainName} 평가시트</h2>
          <p className="metadata-note">
            버전 {sheet.version}
            {sheet.mainConsultationTypes ? ` · 주요 상담 유형: ${sheet.mainConsultationTypes}` : ''}
          </p>
        </div>
        <div className="sheets-row-actions">
          <button type="button" className="sheets-view-btn" disabled={downloading} onClick={() => void onDownload()}>
            {downloading ? '다운로드 중…' : '다운로드 (.xlsx)'}
          </button>
          <button type="button" className="sheets-view-btn" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
      {downloadError && (
        <div className="field-error" role="alert">
          {downloadError}
        </div>
      )}

      <div className="sheet-detail-scroll">
        <table className="sheets-table sheet-detail-table">
          <thead>
            <tr>
              <th>구분</th>
              <th>평가항목</th>
              <th>세부 평가내용</th>
              <th className="num">배점</th>
              <th>게이팅(P/F)</th>
            </tr>
          </thead>
          <tbody>
            {sheet.categories.map((category) =>
              category.items.map((item, idx) => (
                <tr key={item.itemId}>
                  {idx === 0 && (
                    <td rowSpan={category.items.length} className="sheet-detail-category">
                      {category.categoryName}
                      <span className="sheet-detail-subtotal">{category.maxScore}점</span>
                    </td>
                  )}
                  <td>{item.itemName}</td>
                  <td>{item.criteria}</td>
                  <td className="num">{item.maxScore}</td>
                  <td>{item.gating ? <span className="badge-pill sheets-custom">P/F</span> : '-'}</td>
                </tr>
              )),
            )}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3}>합계</td>
              <td className="num">{sheet.totalMaxScore}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      <p className="metadata-note">
        등급 기준: {[...sheet.gradeCriteria].sort((a, b) => b.minScore - a.minScore).map((g) => `${g.minScore}점 이상 ${g.grade}`).join(' / ')}
      </p>
      {sheet.gatingPolicy && <p className="metadata-note">{sheet.gatingPolicy}</p>}
      {sheet.sourceCitation && <p className="metadata-note">{sheet.sourceCitation}</p>}
      {sheet.disclaimer && <p className="metadata-note">{sheet.disclaimer}</p>}
    </section>
  );
});

export function EvalSheetsPage() {
  const [sheets, setSheets] = useState<EvalSheetSummary[]>([]);
  const [loadError, setLoadError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<UploadEvalSheetsResult>();
  const [errors, setErrors] = useState<string[]>([]);
  const [downloadError, setDownloadError] = useState<string>();
  const [downloading, setDownloading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [detail, setDetail] = useState<EvalSheetDetail>();
  const [detailLoading, setDetailLoading] = useState<string>();
  const [detailError, setDetailError] = useState<string>();
  const detailRef = useRef<HTMLElement>(null);

  const refresh = useCallback(async () => {
    try {
      setSheets(await listEvalSheets());
      setLoadError(undefined);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : '평가시트 목록을 불러오지 못했습니다.');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function onFileSelected(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setResult(undefined);
    setErrors([]);
    try {
      setResult(await uploadEvalSheets(file));
      await refresh();
    } catch (e) {
      setErrors(
        e instanceof UploadValidationError
          ? e.details
          : [e instanceof Error ? e.message : '업로드에 실패했습니다.'],
      );
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function onDownload() {
    setDownloading(true);
    setDownloadError(undefined);
    try {
      await downloadEvalSheets();
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : '평가시트를 다운로드하지 못했습니다.');
    } finally {
      setDownloading(false);
    }
  }

  async function onView(sheet: EvalSheetSummary) {
    setDetailLoading(sheet.domainId);
    setDetailError(undefined);
    try {
      setDetail(await getEvalSheetDetail(sheet.domainId));
      requestAnimationFrame(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    } catch (e) {
      setDetail(undefined);
      setDetailError(e instanceof Error ? e.message : '평가시트를 불러오지 못했습니다.');
    } finally {
      setDetailLoading(undefined);
    }
  }

  async function onReset(sheet: EvalSheetSummary) {
    if (
      !window.confirm(
        `'${sheet.domainName}' 평가시트를 기본값으로 되돌릴까요? 업로드로 수정한 내용은 사라집니다.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setResult(undefined);
    setErrors([]);
    try {
      await resetEvalSheet(sheet.domainId);
      await refresh();
    } catch (e) {
      setErrors([e instanceof Error ? e.message : '초기화에 실패했습니다.']);
    } finally {
      setBusy(false);
    }
  }

  // 안내 탭(00_안내)은 정상적으로 무시되므로 경고 대상에서 제외한다.
  const ignoredTabs = (result?.ignoredSheets ?? []).filter((n) => n !== '00_안내');

  return (
    <div className="app-shell">
      <div className="app-shell-inner">
        <TopBar />
        <div className="form-page sheets-page">
          <div className="form-card">
            <div className="form-header">
              <h1>평가시트 관리</h1>
              <p className="metadata-note">
                도메인별 평가시트(Excel)를 다운로드해 평가항목·배점·게이팅을 수정한 뒤 다시 업로드하면, 이후 채점부터
                수정된 기준이 적용됩니다. 이미 완료된 채점 결과는 변경되지 않습니다.
              </p>
            </div>

            <div className="sheets-actions">
              <button
                type="button"
                className="submit-btn sheets-btn"
                disabled={downloading}
                onClick={() => void onDownload()}
              >
                {downloading ? '다운로드 중…' : '평가시트 다운로드 (.xlsx)'}
              </button>
              <button
                type="button"
                className="submit-btn sheets-btn"
                disabled={busy}
                onClick={() => fileInput.current?.click()}
              >
                {busy ? '처리 중…' : '평가시트 업로드 (.xlsx)'}
              </button>
              <input
                ref={fileInput}
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                hidden
                onChange={(e) => void onFileSelected(e.target.files?.[0])}
              />
            </div>
            <p className="metadata-note">
              탭 이름 앞 번호(1_, 2_ …)와 헤더 행을 유지하고 도메인별 배점 합계를 100점으로 맞춰야 합니다. 오류가 하나라도
              있으면 전체 반영이 취소됩니다.
            </p>

            {downloadError && (
              <div className="error-banner" role="alert">
                <div className="error-banner-text">{downloadError}</div>
              </div>
            )}
            {errors.length > 0 && (
              <div className="error-banner" role="alert">
                <div className="error-banner-text">
                  업로드를 반영하지 못했습니다. 아래 항목을 수정한 뒤 다시 업로드해 주세요.
                  <ul className="sheets-error-list">
                    {errors.map((m, i) => (
                      <li key={i}>{m}</li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
            {result && (
              <div className="sheets-success" role="status">
                {result.updated.length === 0
                  ? '변경된 평가 기준이 없어 반영할 내용이 없습니다.'
                  : `${result.updated.map((u) => `${u.domainName}(v${u.version})`).join(', ')} 평가시트가 반영되었습니다. 다음 채점부터 적용됩니다.`}
              </div>
            )}
            {ignoredTabs.length > 0 && (
              <div className="sheets-warning" role="alert">
                다음 탭은 반영되지 않고 무시되었습니다. 탭 이름 앞 번호(1_ ~ 10_)가 올바른지 확인해 주세요. 이 탭에서 수정한
                내용은 적용되지 않았습니다.
                <ul>
                  {ignoredTabs.map((name, i) => (
                    <li key={i}>{name}</li>
                  ))}
                </ul>
              </div>
            )}
            {loadError && <div className="field-error">{loadError}</div>}

            <table className="sheets-table">
              <thead>
                <tr>
                  <th>도메인</th>
                  <th>버전</th>
                  <th>항목 수</th>
                  <th>게이팅</th>
                  <th>상태</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sheets.map((s) => (
                  <tr key={s.domainId}>
                    <td>{s.domainName}</td>
                    <td className="num">{s.version}</td>
                    <td className="num">{s.itemCount}</td>
                    <td className="num">{s.gatingItemCount}</td>
                    <td>
                      {s.customized ? (
                        <span className="badge-pill sheets-custom">
                          수정됨{s.updatedAt ? ` · ${new Date(s.updatedAt).toLocaleString('ko-KR')}` : ''}
                        </span>
                      ) : (
                        <span className="badge-pill">기본</span>
                      )}
                    </td>
                    <td className="sheets-row-actions">
                      <button
                        type="button"
                        className="sheets-view-btn"
                        disabled={detailLoading === s.domainId}
                        aria-pressed={detail?.domainId === s.domainId}
                        onClick={() => void onView(s)}
                      >
                        {detailLoading === s.domainId ? '불러오는 중…' : '보기'}
                      </button>
                      {s.customized && (
                        <button
                          type="button"
                          className="retry-btn"
                          disabled={busy}
                          onClick={() => void onReset(s)}
                        >
                          기본값 복원
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {detailError && <div className="field-error" role="alert">{detailError}</div>}
            {detail && <EvalSheetDetailPanel ref={detailRef} sheet={detail} onClose={() => setDetail(undefined)} />}
          </div>
        </div>
      </div>
    </div>
  );
}
