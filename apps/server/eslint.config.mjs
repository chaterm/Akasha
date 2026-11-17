import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

const LOG_LEVELS = '/^(log|info|warn|error|debug|verbose|fatal)$/';
const LOGGER_RECEIVER = '/[Ll]ogger$/';
const LOG_CALL_MESSAGE =
  "Pass log data as a leading object with a constant message: logger.warn({ pageId, err }, 'Failed to update page') rather than a template literal.";

/** @type {import('eslint').Linter.Config[]} */
export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    ignores: ['eslint.config.mjs'],
  },
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
      sourceType: 'module',
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      'prefer-rest-params': 'off',
      'no-useless-catch': 'off',
      'no-useless-escape': 'off',
      'no-restricted-syntax': [
        'error',
        {
          selector: `CallExpression[arguments.0.type='TemplateLiteral'][callee.property.name=${LOG_LEVELS}][callee.object.name=${LOGGER_RECEIVER}]`,
          message: LOG_CALL_MESSAGE,
        },
        {
          selector: `CallExpression[arguments.0.type='TemplateLiteral'][callee.property.name=${LOG_LEVELS}][callee.object.property.name=${LOGGER_RECEIVER}]`,
          message: LOG_CALL_MESSAGE,
        },
      ],
    },
  },
];
