import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  build: {
    // pnpm 워크스페이스 심볼릭 링크로 연결된 @auto-qa/shared-types(CommonJS 빌드 산출물)를
    // 정상적으로 ESM 인터롭 처리하기 위해 node_modules 밖 실제 경로도 포함한다.
    commonjsOptions: {
      include: [/node_modules/, /packages[\\/]shared-types/],
    },
  },
  optimizeDeps: {
    include: ['@auto-qa/shared-types'],
  },
});
