import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Phase 3 FR-4(M-5) — apps/web에 테스트 러너가 전혀 없었다(Phase 1 리포트에서도 확인됨).
// apps/api(jest)와 동일한 취지로, 순수 함수 단위 테스트가 가능한 최소 구성만 추가한다.
// E2E/커버리지 리포터 등 과도한 구성은 도입하지 않는다(PM 지시).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'src/**/*.spec.tsx'],
  },
});
