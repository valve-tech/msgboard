import prettier from 'eslint-config-prettier'
import prettierConfig from 'eslint-plugin-prettier/recommended'
import js from '@eslint/js'
import globals from 'globals'
import ts from 'typescript-eslint'

export default ts.config(
  {
    ignores: ['dist/**/*', 'node_modules/**/*'],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  prettierConfig,
  prettier,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
)
