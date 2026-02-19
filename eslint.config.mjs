import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        files: ['src/**/*.ts'],
        rules: {
            'no-empty': 'off',
            'no-console': 'off',
            'curly': ['warn', 'multi-line'],
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            '@typescript-eslint/no-unused-expressions': 'off',
            '@typescript-eslint/no-require-imports': 'off',
            '@typescript-eslint/no-empty-interface': 'off',
            '@typescript-eslint/no-non-null-assertion': 'off',
            '@typescript-eslint/explicit-module-boundary-types': 'off',
            'no-case-declarations': 'off',
            'no-bitwise': 'off',
            'prefer-const': 'warn',
            'no-else-return': 'off',
            'sort-keys': 'off',
            'max-classes-per-file': 'off',
        },
    },
    {
        ignores: ['dist/', 'out/', 'common/', 'webview/', '*.js', '*.mjs'],
    },
);
