import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EvaluationService } from './evaluation.service';
import { LLM_EVALUATION_PROVIDER } from './llm/llm-evaluation-provider.interface';
import { MockLlmEvaluationProvider } from './llm/mock-llm-evaluation.provider';
import { AnthropicLlmEvaluationProvider } from './llm/anthropic-llm-evaluation.provider';
import { GeminiLlmEvaluationProvider } from './llm/gemini-llm-evaluation.provider';

/**
 * env `LLM_PROVIDER`(기본값 mock)에 따라 LlmEvaluationProvider 구현체를 주입한다.
 * EvaluationService는 어떤 구현체가 주입되었는지 알지 못한다(NFR-2.2/2.3).
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
            return anthropic;
          case 'gemini':
            return gemini;
          case 'mock':
          default:
            return mock;
        }
      },
    },
    EvaluationService,
  ],
  exports: [EvaluationService],
})
export class EvaluationModule {}
