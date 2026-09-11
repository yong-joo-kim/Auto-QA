interface EvaluationMetaFooterProps {
  evalSheetVersion: string;
  llmProvider: string;
  llmModel: string;
  sourceCitation?: string;
  disclaimer?: string;
}

export function EvaluationMetaFooter({
  evalSheetVersion,
  llmProvider,
  llmModel,
  sourceCitation,
  disclaimer,
}: EvaluationMetaFooterProps) {
  return (
    <div className="footnote-block">
      {sourceCitation && <div className="footnote-text">출처(컴플라이언스 근거): {sourceCitation}</div>}
      {disclaimer && <div className="footnote-text">※ {disclaimer}</div>}
      <div className="footnote-text">
        평가시트 v{evalSheetVersion} · Provider: {llmProvider} ({llmModel})
      </div>
    </div>
  );
}
