import { useEffect, useState } from 'react';
import type {
  CategoryScoreResult,
  EvaluationItemResult,
  EvaluationResultResponse,
} from '@auto-qa/shared-types';
import { ApiError, overrideItemScore } from '../api/client';
import { formatDateTime } from '../utils/formatDateTime';
import { PencilIcon, SpinnerIcon } from './icons';

interface ItemDetailSectionsProps {
  categories: CategoryScoreResult[];
  itemsByCategory: Map<string, EvaluationItemResult[]>;
  /** 점수 보정(Override) API 호출 시 사용할 평가 ID(FR-10, §4.5) */
  evaluationId: string;
  /** 보정 저장 성공 시 서버가 재계산한 전체 결과로 화면을 갱신한다(NFR-5.1 — 클라이언트가 직접 재계산하지 않음). */
  onOverrideSaved: (result: EvaluationResultResponse) => void;
}

/**
 * 카테고리별 항목 상세(배점/획득점수/사유). 게이팅 항목은 텍스트 라벨 + P/F 배지를 함께
 * 표시한다(색상 단독 의존 금지, UI 설계서 §6). 점수 옆 편집 아이콘 클릭 시 인라인 보정
 * 편집 모드로 전환된다(FR-10).
 */
export function ItemDetailSections({
  categories,
  itemsByCategory,
  evaluationId,
  onOverrideSaved,
}: ItemDetailSectionsProps) {
  const [editingItemId, setEditingItemId] = useState<string | null>(null);

  return (
    <div className="item-detail-section-wrap">
      <div className="item-detail-header-row">
        <div className="section-label">항목별 상세</div>
        <div className="item-detail-hint">
          <PencilIcon size={12} color="var(--text-faint)" />
          연필 아이콘을 클릭하면 QA 관리자가 점수를 직접 보정할 수 있습니다
        </div>
      </div>

      {categories.map((category) => {
        const items = itemsByCategory.get(category.categoryId) ?? [];
        const hasGatingFail = items.some((item) => item.gating && item.passFail === 'F');
        return (
          <div
            className={`item-category-card${hasGatingFail ? ' gating-fail' : ''}`}
            id={`category-${category.categoryId}`}
            key={category.categoryId}
          >
            <div className="item-category-header">
              <div className="item-category-title">{category.categoryName}</div>
              <div className="num item-category-score">
                {category.score} / {category.maxScore}
              </div>
            </div>
            <div>
              {items.map((item) => (
                <ItemDetailRow
                  key={item.itemId}
                  item={item}
                  evaluationId={evaluationId}
                  isEditing={editingItemId === item.itemId}
                  onStartEdit={() => setEditingItemId(item.itemId)}
                  onCancelEdit={() => setEditingItemId(null)}
                  onSaved={(result) => {
                    setEditingItemId(null);
                    onOverrideSaved(result);
                  }}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface ItemDetailRowProps {
  item: EvaluationItemResult;
  evaluationId: string;
  isEditing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaved: (result: EvaluationResultResponse) => void;
}

function ItemDetailRow({
  item,
  evaluationId,
  isEditing,
  onStartEdit,
  onCancelEdit,
  onSaved,
}: ItemDetailRowProps) {
  const isFail = item.gating && item.passFail === 'F';
  const [scoreInput, setScoreInput] = useState(String(item.score));
  const [note, setNote] = useState(item.overrideNote ?? '');
  const [reviewer, setReviewer] = useState(item.overrideReviewer ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // 편집 모드에 새로 진입할 때마다 폼 값을 현재 항목 상태로 재초기화한다.
  useEffect(() => {
    if (isEditing) {
      setScoreInput(String(item.score));
      setNote(item.overrideNote ?? '');
      setReviewer(item.overrideReviewer ?? '');
      setError(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditing]);

  async function handleSave() {
    const parsedScore = Number(scoreInput);
    if (!Number.isInteger(parsedScore) || parsedScore < 0 || parsedScore > item.maxScore) {
      setError(`점수는 0 ~ ${item.maxScore} 사이의 정수여야 합니다.`);
      return;
    }

    setSaving(true);
    setError(undefined);
    try {
      const result = await overrideItemScore(evaluationId, item.itemId, {
        score: parsedScore,
        note: note.trim() ? note.trim() : undefined,
        reviewer: reviewer.trim() ? reviewer.trim() : undefined,
      });
      onSaved(result);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : '점수 보정 저장 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
      );
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    setError(undefined);
    onCancelEdit();
  }

  return (
    <div
      className={`item-row${isFail ? ' gating-fail-row' : ''}${
        item.overridden ? ' overridden-row' : ''
      }`}
    >
      <div className="item-row-top">
        <div className="item-row-name-wrap">
          {item.gating && (
            <span className={`gating-label${isFail ? ' fail' : ''}`}>게이팅</span>
          )}
          <span className="item-row-name">{item.itemName}</span>
          {item.overridden && !isEditing && (
            <span className="override-badge">관리자 보정</span>
          )}
        </div>
        {!isEditing && (
          <div className="item-row-score-wrap">
            {item.overridden && typeof item.originalScore === 'number' && (
              <span className="num override-original-score">{item.originalScore}</span>
            )}
            <span className="num item-row-score">
              {item.score} / {item.maxScore}
            </span>
            {item.gating && item.passFail && (
              <span className={`pf-badge ${item.passFail === 'P' ? 'pass' : 'fail'}`}>
                {item.passFail} {item.passFail === 'P' ? '통과' : '실패'}
              </span>
            )}
            <button
              type="button"
              className="edit-btn"
              onClick={onStartEdit}
              title="점수 수동 보정(Override)"
            >
              <PencilIcon />
            </button>
          </div>
        )}
      </div>

      <div className="item-row-reason">배점 사유: {item.reason}</div>

      {item.overridden && !isEditing && (
        <div className="override-meta">
          {item.overrideNote && <div className="override-note">보정 메모: {item.overrideNote}</div>}
          <div className="override-by">
            {item.overrideReviewer && <span>{item.overrideReviewer} · </span>}
            {item.overriddenAt && <span>{formatDateTime(item.overriddenAt)} 보정됨</span>}
          </div>
        </div>
      )}

      {isEditing && (
        <div className="override-form">
          <div className="override-form-row">
            <label className="override-form-field">
              <span>점수 (0~{item.maxScore})</span>
              <input
                type="number"
                min={0}
                max={item.maxScore}
                step={1}
                value={scoreInput}
                onChange={(e) => setScoreInput(e.target.value)}
                disabled={saving}
              />
            </label>
            <label className="override-form-field">
              <span>보정 메모 (선택)</span>
              <input
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={saving}
                placeholder="보정 사유를 입력하세요"
              />
            </label>
            <label className="override-form-field">
              <span>평가자 (선택)</span>
              <input
                type="text"
                value={reviewer}
                onChange={(e) => setReviewer(e.target.value)}
                disabled={saving}
                placeholder="이름"
              />
            </label>
          </div>

          {error && (
            <div className="field-error" role="alert">
              <span aria-hidden="true">⚠</span> {error}
            </div>
          )}

          <div className="override-form-actions">
            <button
              type="button"
              className="override-cancel-btn"
              onClick={handleCancel}
              disabled={saving}
            >
              취소
            </button>
            <button
              type="button"
              className="override-save-btn"
              onClick={handleSave}
              disabled={saving}
              aria-busy={saving}
            >
              {saving ? (
                <>
                  <SpinnerIcon size={13} color="white" /> 저장 중...
                </>
              ) : (
                '저장'
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
