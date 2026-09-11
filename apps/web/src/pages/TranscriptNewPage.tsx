import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { CreateTranscriptRequest, DomainId, TranscriptMetadata } from '@auto-qa/shared-types';
import { countNonWhitespace, MIN_TRANSCRIPT_NON_WHITESPACE_LENGTH } from '@auto-qa/shared-types';
import { ApiError, createTranscript } from '../api/client';
import { DOMAIN_OPTIONS } from '../domain/domains';
import { DomainSelector } from '../components/DomainSelector';
import { TranscriptTextarea } from '../components/TranscriptTextarea';
import {
  MetadataFieldsAccordion,
  type MetadataFieldsValue,
} from '../components/MetadataFieldsAccordion';
import { PiiNoticeCallout } from '../components/PiiNoticeCallout';
import { SubmissionErrorBanner } from '../components/SubmissionErrorBanner';
import { SubmitBar } from '../components/SubmitBar';
import { TopBar } from '../components/TopBar';

const MIN_LENGTH = MIN_TRANSCRIPT_NON_WHITESPACE_LENGTH;

type FormStatus = 'idle' | 'invalid' | 'submitting' | 'submit-error';

function buildMetadata(value: MetadataFieldsValue): TranscriptMetadata | undefined {
  const metadata: TranscriptMetadata = {};
  if (value.agentId.trim()) metadata.agentId = value.agentId.trim();
  if (value.consultedAt.trim()) metadata.consultedAt = value.consultedAt.trim();
  if (value.channel) metadata.channel = value.channel;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function TranscriptNewPage() {
  const navigate = useNavigate();
  const [domainId, setDomainId] = useState<DomainId>('telecom');
  const [transcript, setTranscript] = useState('');
  const [metadata, setMetadata] = useState<MetadataFieldsValue>({
    agentId: '',
    consultedAt: '',
    channel: '',
  });
  const [status, setStatus] = useState<FormStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);

  const errorBannerRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    if (status === 'invalid') {
      const el = document.getElementById('transcript-textarea');
      el?.focus();
    } else if (status === 'submit-error') {
      errorBannerRef.current?.focus();
    }
  }, [status]);

  const inlineErrorMessage =
    status === 'invalid' ? '공백 제외 10자 이상 입력해 주세요.' : undefined;

  async function handleSubmit() {
    const trimmedLen = countNonWhitespace(transcript);
    if (trimmedLen < MIN_LENGTH) {
      setStatus('invalid');
      return;
    }

    setStatus('submitting');
    setErrorMessage(undefined);

    const payload: CreateTranscriptRequest = {
      domainId,
      rawText: transcript,
      metadata: buildMetadata(metadata),
    };

    try {
      const result = await createTranscript(payload);
      navigate(`/transcripts/${result.transcriptId}`);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : '채점 요청 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';
      setErrorMessage(message);
      setStatus('submit-error');
    }
  }

  const isSubmitting = status === 'submitting';

  return (
    <div className="app-shell">
      <div className="app-shell-inner">
        <TopBar />
        <div className="form-page">
          <div className="form-card">
            <div className="form-header">
              <h1 ref={headingRef} tabIndex={-1}>
                상담대화 평가 요청
              </h1>
              <p>상담대화 원문을 입력하면 도메인 평가시트 기준으로 자동 채점합니다.</p>
            </div>

            <DomainSelector
              domains={DOMAIN_OPTIONS}
              value={domainId}
              onChange={setDomainId}
              disabled={isSubmitting}
            />

            <TranscriptTextarea
              value={transcript}
              onChange={(value) => {
                setTranscript(value);
                if (status === 'invalid' && countNonWhitespace(value) >= MIN_LENGTH) {
                  setStatus('idle');
                }
              }}
              minLength={MIN_LENGTH}
              errorMessage={inlineErrorMessage}
              disabled={isSubmitting}
            />

            <MetadataFieldsAccordion value={metadata} onChange={setMetadata} />

            <PiiNoticeCallout />

            {status === 'submit-error' && errorMessage && (
              <SubmissionErrorBanner
                ref={errorBannerRef}
                message={errorMessage}
                onRetry={handleSubmit}
              />
            )}

            <SubmitBar loading={isSubmitting} disabled={isSubmitting} onSubmit={handleSubmit} />
          </div>
        </div>
      </div>
    </div>
  );
}
