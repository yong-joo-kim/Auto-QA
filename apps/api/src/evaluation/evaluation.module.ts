import { Logger, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EvaluationService } from './evaluation.service';
import { LLM_EVALUATION_PROVIDER } from './llm/llm-evaluation-provider.interface';
import { MockLlmEvaluationProvider } from './llm/mock-llm-evaluation.provider';
import { AnthropicLlmEvaluationProvider } from './llm/anthropic-llm-evaluation.provider';
import { GeminiLlmEvaluationProvider } from './llm/gemini-llm-evaluation.provider';
import { assertHeaderSafeApiKeyFormat } from './llm/env-utils';

const moduleLogger = new Logger('EvaluationModule');

/**
 * env `LLM_PROVIDER`(기본값 mock)에 따라 LlmEvaluationProvider 구현체를 주입한다.
 * EvaluationService는 어떤 구현체가 주입되었는지 알지 못한다(NFR-2.2/2.3).
 *
 * FR-8: `gemini` 선택 시 필수 설정(GEMINI_API_KEY/GEMINI_MODEL) 누락을 애플리케이션
 * 기동 시점에 fail-fast로 검출한다(첫 요청에서야 실패하지 않도록). `mock`(기본값)일 때는
 * Gemini 관련 env가 전혀 없어도 정상 기동해야 한다(FR-8.3) — 이 팩토리 함수는 provider가
 * 실제로 'gemini'일 때만 검증한다.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    MockLlmEvaluationProvider,
    AnthropicLlmEvaluationProvider,
    GeminiLlmEvaluationProvider,
    {
      provide: LLM_EVALUATION_PROVIDER,
      inject: [ConfigService, MockLlmEvaluationProvider, AnthropicLlmEvaluationProvider, GeminiLlmEvaluationProvider],
      useFactory: (
        config: ConfigService,
        mock: MockLlmEvaluationProvider,
        anthropic: AnthropicLlmEvaluationProvider,
        gemini: GeminiLlmEvaluationProvider,
      ) => {
        const provider = config.get<string>('LLM_PROVIDER', 'mock');
        switch (provider) {
          case 'anthropic':
            moduleLogger.log(`LLM provider: anthropic (model=${config.get<string>('ANTHROPIC_MODEL', 'claude-sonnet-5')})`);
            return anthropic;
          case 'gemini': {
            // L-9: 후행/선행 공백(.env 붙여넣기 실수 등)이 섞인 키를 검증/사용 이전에 제거한다.
            // trim 없이 검증만 하면 공백 낀 원본 키가 그대로 실제 HTTP 요청에 쓰여 무의미하므로,
            // 이후 검증(assertHeaderSafeApiKeyFormat)과 실제 사용 모두 trim된 값을 기준으로 한다.
            const apiKey = config.get<string>('GEMINI_API_KEY')?.trim();
            // L-11: GEMINI_API_KEY/GEMINI_API_BASE_URL과 동일하게 trim한다 — 후행 공백이 섞인
            // 모델명이 이 fail-fast 검증은 통과한 뒤 실제 호출 시 encodeURIComponent를 거쳐
            // URL에 %20으로 들어가 런타임 404를 유발할 수 있다.
            const model = config.get<string>('GEMINI_MODEL')?.trim();
            if (!apiKey) {
              throw new Error(
                'LLM_PROVIDER=gemini이지만 GEMINI_API_KEY가 설정되지 않았습니다. .env를 확인하세요.',
              );
            }
            if (!model) {
              throw new Error(
                'LLM_PROVIDER=gemini이지만 GEMINI_MODEL이 설정되지 않았습니다. .env를 확인하세요.',
              );
            }
            // H-1: 개행 등 HTTP 헤더로 허용되지 않는 문자가 섞인 키는 기동 시점에 걸러낸다
            // (첫 요청에서야 Headers.append TypeError로 실패하며 키 전문이 로그에 노출되는
            // 경로를 원천 차단한다).
            assertHeaderSafeApiKeyFormat(apiKey, 'GEMINI_API_KEY');
            moduleLogger.log(`LLM provider: gemini (model=${model})`);
            return gemini;
          }
          case 'mock':
          default:
            moduleLogger.log('LLM provider: mock');
            return mock;
        }
      },
    },
    EvaluationService,
  ],
  exports: [EvaluationService],
})
export class EvaluationModule {}
