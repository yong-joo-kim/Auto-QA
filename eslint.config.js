// Auto QA — 최소 ESLint 구성 (M-7 후속 조치)
// 목적: `pnpm lint`가 아무 규칙도 적용하지 않고 무조건 통과하던 문제(위양성)를 해소한다.
// 범위: 타입 인지(type-aware) 규칙은 모노레포 전역 tsconfig 참조 설정이 필요해 비용이 크므로
//       비-타입체크 recommended 규칙셋만 적용한다(최소 구성). 필요 시 후속 Phase에서 확장.
const tseslint = require('typescript-eslint');
const reactHooks = require('eslint-plugin-react-hooks');

module.exports = tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.d.ts',
      '**/*.js',
      'apps/api/prisma/**',
      'seed/**',
      'docs/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      // Nest 데코레이터/DI 패턴 및 zod 파싱 결과 사용 시 any가 불가피한 경우가 있어 경고로 완화
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // apps/web에서만 React Hooks 규칙 적용(기존 eslint-disable-next-line 주석이 실제 규칙을 참조하도록)
    files: ['apps/web/**/*.tsx', 'apps/web/**/*.ts'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/exhaustive-deps': 'warn',
      'react-hooks/rules-of-hooks': 'error',
    },
  },
);
