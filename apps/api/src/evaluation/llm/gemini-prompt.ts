import { EvalSheet } from '@auto-qa/eval-schema';

/**
 * Gemini 채점 프롬프트 템플릿 (FR-4).
 *
 * 리뷰 가능하도록 프롬프트 텍스트를 별도 모듈로 분리한다(FR-4.4). system instruction과
 * user content를 나누어 구성하며, 평가시트는 사람이 읽기 쉬운 표 형태로 직렬화한다.
 *
 * FR-4.4 명시: `sourceCitation`(있는 경우, 컴플라이언스 항목 근거로 프롬프트에 포함)만
 * 포함하고 `disclaimer`(채점과 무관한 내부 면책 문구)는 제외한다.
 */

export function buildGeminiSystemInstruction(evalSheet: EvalSheet): string {
  const gatingPolicy =
    evalSheet.gatingPolicy ??
    '게이팅(치명) 항목이 하나라도 F(탈락)이면 총점과 무관하게 전체 상담이 "탈락(재검토 필요)"로 판정된다.';

  const lines: string[] = [];
  lines.push('당신은 콜센터 상담 품질(QA)을 평가하는 전문 평가자입니다.');
  lines.push(
    `아래에 주어지는 "${evalSheet.domainName}" 도메인 평가시트의 기준에 따라, 마스킹된 상담 대화록을 항목별로 채점하고 사유를 작성하세요.`,
  );
  lines.push('');
  lines.push('## 채점 규칙');
  lines.push('1. 응답은 반드시 지정된 JSON 스키마 구조를 따릅니다. 스키마 밖의 임의 필드를 추가하지 마세요.');
  lines.push('2. 모든 점수는 정수이며, 각 항목의 배점(만점)을 초과할 수 없습니다.');
  lines.push('3. 사유(reason)는 반드시 한국어로, 대화 내용에 근거하여 구체적으로 작성하세요. 대화에 없는 내용을 추측해서 작성하지 마세요.');
  lines.push(`4. 게이팅(치명) 항목 판정 규칙: ${gatingPolicy}`);
  lines.push('5. 게이팅 항목은 반드시 P(통과) 또는 F(탈락) 중 하나로 판정하세요.');
  lines.push('');
  lines.push('## 마스킹 placeholder 안내 (중요)');
  lines.push(
    '대화록의 [전화번호], [주민등록번호], [이메일], [카드번호], [계좌번호] 등은 개인정보 보호를 위해 시스템이 원문을 대체한 표시(placeholder)입니다.',
  );
  lines.push(
    '이 표시 자체를 상담사가 실제로 말한 이상한 문구로 오해하거나 감점 근거로 삼지 마세요. 또한 사유(reason)에서 이 표시가 원래 무엇이었는지 추측하거나 복원하려는 시도를 하지 마세요.',
  );
  lines.push('');
  lines.push('## 코칭 작성 지침');
  lines.push(
    '코칭(goodPoints/improvements)은 상담사 본인에게 직접 전달되는 글이므로, 존중하는 어조의 한국어로 작성하세요. goodPoints는 1~3개, improvements는 1~3개입니다.',
  );

  if (evalSheet.sourceCitation) {
    lines.push('');
    lines.push('## 평가시트 근거 출처');
    lines.push(evalSheet.sourceCitation);
  }

  return lines.join('\n');
}

export function buildGeminiUserContent(evalSheet: EvalSheet, maskedTranscript: string): string {
  const lines: string[] = [];
  lines.push(`# 평가시트: ${evalSheet.domainName} (버전 ${evalSheet.version})`);
  if (evalSheet.mainConsultationTypes) {
    lines.push(`주요 상담 유형: ${evalSheet.mainConsultationTypes}`);
  }
  lines.push(`총 배점: ${evalSheet.totalMaxScore}점`);
  lines.push('');

  for (const category of evalSheet.categories) {
    lines.push(`## 카테고리: ${category.categoryName} (${category.categoryId}, 배점 ${category.maxScore}점)`);
    for (const item of category.items) {
      lines.push(
        `- itemId="${item.itemId}" | 항목명: ${item.itemName} | 배점: ${item.maxScore}점 | 게이팅 여부: ${item.gating ? '예(P/F 판정 필요)' : '아니오'}`,
      );
      lines.push(`  세부 평가 기준: ${item.criteria}`);
    }
    lines.push('');
  }

  lines.push('# 채점 대상 상담 대화록 (PII 마스킹 완료)');
  lines.push('---');
  lines.push(maskedTranscript);
  lines.push('---');
  lines.push('');
  lines.push(
    '위 평가시트의 모든 itemId에 대해 빠짐없이 점수와 사유를 산정하고, 지정된 JSON 스키마 형식으로만 응답하세요.',
  );

  return lines.join('\n');
}
