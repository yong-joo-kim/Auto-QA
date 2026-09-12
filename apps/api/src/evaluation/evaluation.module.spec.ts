import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { EvaluationModule } from './evaluation.module';
import { EvaluationService } from './evaluation.service';

/**
 * FR-8/AC-6: LLM_PROVIDER=gemini인데 GEMINI_API_KEY/GEMINI_MODEL이 비어 있으면 애플리케이션
 * 기동 시점에 실패해야 하고(첫 요청이 아니라 부팅 단계), LLM_PROVIDER=mock(기본값)일 때는
 * Gemini 관련 env가 전혀 없어도 정상 기동해야 한다(FR-8.3).
 */
describe('EvaluationModule — provider 선택 및 fail-fast (FR-8)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('LLM_PROVIDER=gemini이고 GEMINI_API_KEY가 없으면 모듈 부팅이 실패한다', async () => {
    process.env.LLM_PROVIDER = 'gemini';
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_MODEL;

    await expect(
      Test.createTestingModule({
        imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), EvaluationModule],
      }).compile(),
    ).rejects.toThrow('GEMINI_API_KEY가 설정되지 않았습니다');
  });

  test('LLM_PROVIDER=gemini이고 GEMINI_API_KEY는 있지만 GEMINI_MODEL이 없으면 모듈 부팅이 실패한다', async () => {
    process.env.LLM_PROVIDER = 'gemini';
    process.env.GEMINI_API_KEY = 'dummy-key-for-test-not-a-real-secret';
    delete process.env.GEMINI_MODEL;

    await expect(
      Test.createTestingModule({
        imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), EvaluationModule],
      }).compile(),
    ).rejects.toThrow('GEMINI_MODEL이 설정되지 않았습니다');
  });

  test('H-1: LLM_PROVIDER=gemini이고 GEMINI_API_KEY에 개행이 섞이면 모듈 부팅이 실패하고 키 값이 메시지에 노출되지 않는다', async () => {
    const maliciousKey = 'AIzaSy\nFAKE123-not-a-real-secret';
    process.env.LLM_PROVIDER = 'gemini';
    process.env.GEMINI_API_KEY = maliciousKey;
    process.env.GEMINI_MODEL = 'gemini-test-model';

    let caught: unknown;
    try {
      await Test.createTestingModule({
        imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), EvaluationModule],
      }).compile();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain('GEMINI_API_KEY 형식이 올바르지 않습니다');
    expect(message).not.toContain('AIzaSy');
    expect(message).not.toContain('FAKE123');
    expect(message).not.toContain(maliciousKey);
  });

  test('L-9(리뷰 round2, Low, 수정 후): GEMINI_API_KEY에 후행 공백이 섞여도 trim되어 모듈 부팅이 성공한다', async () => {
    // trim 추가 이후 동작: .env 붙여넣기 실수 등으로 흔히 섞이는 선행/후행 공백은 검증 이전에
    // 제거되어 형식 오류로 오분류되지 않는다(리뷰 round2 L-9 수정).
    process.env.LLM_PROVIDER = 'gemini';
    process.env.GEMINI_API_KEY = 'valid-looking-key-not-a-real-secret ';
    process.env.GEMINI_MODEL = 'gemini-test-model';

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), EvaluationModule],
    }).compile();

    expect(moduleRef.get(EvaluationService)).toBeInstanceOf(EvaluationService);
    await moduleRef.close();
  });

  test('LLM_PROVIDER=mock(기본값)이면 Gemini env가 전혀 없어도 정상 기동한다', async () => {
    delete process.env.LLM_PROVIDER;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_MODEL;

    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), EvaluationModule],
    }).compile();

    expect(moduleRef.get(EvaluationService)).toBeInstanceOf(EvaluationService);
    await moduleRef.close();
  });
});
