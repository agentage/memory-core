import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      'prefer-const': 'error',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // The cache module is type-agnostic on purpose: it manages bytes and knows
    // zero engine semantics. This lint gate IS that boundary.
    files: ['src/cache/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '**/contract',
                '**/contract/**',
                '**/stores',
                '**/stores/**',
                '../index.js',
                '../../index.js',
              ],
              message:
                'src/cache is engine-agnostic: it manages bytes only. No contract/store types.',
            },
          ],
        },
      ],
    },
  }
);
