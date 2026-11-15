import js from '@eslint/js';
import globals from 'globals';
export default [
  {
    files: ['src/client/**/*.js', 'scripts/qa/**/*.js'],
    languageOptions: { globals: globals.browser },
  },
  {
    ignores: [
      'node_modules/**',
      'tmp/**',
      'public/build/**',
      'coverage/**',
      'src/db/migrations/**',
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }] },
  },
];
