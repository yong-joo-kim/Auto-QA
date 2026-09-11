import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Evaluation } from '@prisma/client';
import { EvalSheet } from '@auto-qa/eval-schema';
import { maskPii } from '@auto-qa/pii-mask';
import {
  countNonWhitespace,
  CreateTranscriptRequest,
  CreateTranscriptResponse,
  DomainId,
  EvaluationItemResult,
  EvaluationResultResponse,
  EvaluationStatus,
  Grade,
  GatingResult,
  LlmProviderId,
  MIN_TRANSCRIPT_NON_WHITESPACE_LENGTH,
  OverrideItemScoreRequest,
} from '@auto-qa/shared-types';
import { PrismaService } from '../prisma/prisma.service';
import { EvalSheetsService } from '../eval-sheets/eval-sheets.service';
import { aggregateFromScoredItems, EvaluationService } from '../evaluation/evaluation.service';

@Injectable()
export class TranscriptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly evalSheets: EvalSheetsService,
    private readonly evaluationService: EvaluationService,
  ) {}

  async createAndEvaluate(dto: CreateTranscriptRequest): Promise<CreateTranscriptResponse> {
    this.assertValidRawText(dto.rawText);

    // FR-11.4: 존재하지 않는 domainId(오타 등)만 400으로 거부한다. DTO의 @IsIn(DOMAIN_IDS)로도
    // 1차 방어되지만, 서비스 계층에서도 방어적으로 처리한다(다중 도메인 지원, FR-11).
    const evalSheet = this.getEvalSheetOrThrow(dto.domainId);

    // rawText는 마스킹 직후 이 함수 스코프 밖에서 참조되지 않는다.
    // 이후 단계(LLM 요청/DB 저장/로그)에서는 오직 maskedText만 사용한다(NFR-1.1/1.2).
    const { maskedText } = maskPii(dto.rawText);

    const aggregation = await this.evaluationService.evaluateAndAggregate(
      dto.domainId,
      maskedText,
      evalSheet,
    );

    // 트랜스크립트/평가 결과를 하나의 트랜잭션으로 원자적 저장한다(LLM 실패 시 이 지점에
    // 도달하지 않으므로 부분 저장이 발생하지 않는다 — NFR-3.2).
    const { transcriptId, evaluationId } = await this.prisma.$transaction(async (tx) => {
      const transcript = await tx.transcript.create({
        data: {
          domainId: dto.domainId,
          maskedText,
          metadata: dto.metadata ? JSON.stringify(dto.metadata) : null,
        },
      });

      const evaluation = await tx.evaluation.create({
        data: {
          transcriptId: transcript.id,
          domainId: dto.domainId,
          evalSheetVersion: evalSheet.version,
          llmProvider: aggregation.llmProviderMeta.provider,
          llmModel: aggregation.llmProviderMeta.model,
          status: aggregation.status,
          items: JSON.stringify(aggregation.items),
          categoryScores: JSON.stringify(aggregation.categoryScores),
          totalScore: aggregation.totalScore,
          totalMaxScore: aggregation.totalMaxScore,
          grade: aggregation.grade,
          gatingResult: aggregation.gatingResult,
          failedGatingItems: JSON.stringify(aggregation.failedGatingItems),
          goodPoints: JSON.stringify(aggregation.goodPoints),
          improvements: JSON.stringify(aggregation.improvements),
          profanityDetected: aggregation.profanityDetected,
          profanityMatches: JSON.stringify(aggregation.profanityMatches),
        },
      });

      return { transcriptId: transcript.id, evaluationId: evaluation.id };
    });

    return { transcriptId, evaluationId };
  }

  async getResult(transcriptId: string): Promise<EvaluationResultResponse> {
    const transcript = await this.prisma.transcript.findUnique({
      where: { id: transcriptId },
      include: { evaluation: true },
    });

    if (!transcript || !transcript.evaluation) {
      throw new NotFoundException('요청하신 평가 결과를 찾을 수 없습니다.');
    }

    return this.toResponse(transcript, transcript.evaluation);
  }

  /** GET /evaluations/:id 대안 조회 경로 (UI 설계서 §3.2 참고) */
  async getResultByEvaluationId(evaluationId: string): Promise<EvaluationResultResponse> {
    const evaluation = await this.prisma.evaluation.findUnique({
      where: { id: evaluationId },
      include: { transcript: true },
    });

    if (!evaluation) {
      throw new NotFoundException('요청하신 평가 결과를 찾을 수 없습니다.');
    }

    return this.toResponse(evaluation.transcript, evaluation);
  }

  private toResponse(
    transcript: { id: string; domainId: string },
    evaluation: Evaluation,
  ): EvaluationResultResponse {
    const evalSheet = this.evalSheets.getSheet(transcript.domainId);

    return {
      id: evaluation.id,
      transcriptId: transcript.id,
      domainId: transcript.domainId as DomainId,
      domainName: evalSheet.domainName,
      evalSheetVersion: evaluation.evalSheetVersion,
      llmProvider: evaluation.llmProvider as LlmProviderId,
      llmModel: evaluation.llmModel,
      status: evaluation.status as EvaluationStatus,
      items: JSON.parse(evaluation.items) as EvaluationResultResponse['items'],
      categoryScores: JSON.parse(evaluation.categoryScores) as EvaluationResultResponse['categoryScores'],
      totalScore: evaluation.totalScore,
      totalMaxScore: evaluation.totalMaxScore,
      grade: evaluation.grade as Grade,
      gatingResult: evaluation.gatingResult as GatingResult,
      failedGatingItems: JSON.parse(evaluation.failedGatingItems) as EvaluationResultResponse['failedGatingItems'],
      goodPoints: JSON.parse(evaluation.goodPoints) as string[],
      improvements: JSON.parse(evaluation.improvements) as string[],
      profanityDetected: evaluation.profanityDetected,
      profanityMatches: JSON.parse(evaluation.profanityMatches) as EvaluationResultResponse['profanityMatches'],
      sourceCitation: evalSheet.sourceCitation,
      disclaimer: evalSheet.disclaimer,
      createdAt: evaluation.createdAt.toISOString(),
    };
  }

  /**
   * 점수 수동 보정(Override) API (FR-10, §4.5).
   * 대상 evaluation/item 존재 여부(404), score 범위(0~maxScore, 정수, 400)를 검증한 뒤
   * 해당 item의 score를 갱신하고, items 배열 전체로부터 categoryScores/totalScore/grade/
   * gatingResult를 서버에서 전부 재계산한다(NFR-5.1과 동일 원칙, `aggregateFromScoredItems` 재사용).
   * gating 항목이어도 passFail 값 자체는 자동으로 바꾸지 않는다(점수와 게이팅 판정은 별개).
   */
  async overrideItemScore(
    evaluationId: string,
    itemId: string,
    dto: OverrideItemScoreRequest,
  ): Promise<EvaluationResultResponse> {
    const evaluation = await this.prisma.evaluation.findUnique({
      where: { id: evaluationId },
      include: { transcript: true },
    });

    if (!evaluation) {
      throw new NotFoundException('요청하신 평가 결과를 찾을 수 없습니다.');
    }

    const items = JSON.parse(evaluation.items) as EvaluationItemResult[];
    const targetIndex = items.findIndex((item) => item.itemId === itemId);

    if (targetIndex === -1) {
      throw new NotFoundException(`요청하신 평가 항목을 찾을 수 없습니다. (itemId=${itemId})`);
    }

    const target = items[targetIndex];

    if (
      typeof dto.score !== 'number' ||
      !Number.isInteger(dto.score) ||
      dto.score < 0 ||
      dto.score > target.maxScore
    ) {
      throw new BadRequestException(
        `score는 0~${target.maxScore} 범위의 정수여야 합니다. (score=${dto.score})`,
      );
    }

    const now = new Date().toISOString();
    const updatedItem: EvaluationItemResult = {
      ...target,
      score: dto.score,
      // 최초 AI 점수는 최초 1회만 기록한다. 이미 overridden 상태에서 재보정 시 덮어쓰지 않는다.
      originalScore: target.overridden ? target.originalScore ?? target.score : target.score,
      overridden: true,
      overrideNote: dto.note ?? null,
      overrideReviewer: dto.reviewer ?? null,
      overriddenAt: now,
    };

    const updatedItems = [...items];
    updatedItems[targetIndex] = updatedItem;

    const evalSheet = this.getEvalSheetOrThrow(evaluation.domainId);
    const recalculated = aggregateFromScoredItems(updatedItems, evalSheet);

    // Evaluation.status는 override로 자동 변경하지 않는다(manual_review였어도 유지, §4.5).
    await this.prisma.evaluation.update({
      where: { id: evaluationId },
      data: {
        items: JSON.stringify(recalculated.items),
        categoryScores: JSON.stringify(recalculated.categoryScores),
        totalScore: recalculated.totalScore,
        totalMaxScore: recalculated.totalMaxScore,
        grade: recalculated.grade,
        gatingResult: recalculated.gatingResult,
        failedGatingItems: JSON.stringify(recalculated.failedGatingItems),
      },
    });

    return this.getResultByEvaluationId(evaluationId);
  }

  /** domainId에 대응하는 평가시트를 로드한다. 존재하지 않는 domainId는 400으로 거부한다(FR-11.4). */
  private getEvalSheetOrThrow(domainId: string): EvalSheet {
    try {
      return this.evalSheets.getSheet(domainId);
    } catch {
      throw new BadRequestException(`지원하지 않는 domainId입니다. (domainId=${domainId})`);
    }
  }

  private assertValidRawText(rawText: string): void {
    if (typeof rawText !== 'string') {
      throw new BadRequestException('rawText는 문자열이어야 합니다.');
    }
    const nonWhitespaceLength = countNonWhitespace(rawText);
    if (nonWhitespaceLength < MIN_TRANSCRIPT_NON_WHITESPACE_LENGTH) {
      throw new BadRequestException(
        `트랜스크립트는 공백 제외 최소 ${MIN_TRANSCRIPT_NON_WHITESPACE_LENGTH}자 이상이어야 합니다.`,
      );
    }
  }
}
