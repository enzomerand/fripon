import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '.output/',
      '.wxt/',
      '.claude/',
      'node_modules/',
      'docs/mockups/',
      'safari/',
      'server/dist/',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.webextensions } },
  },
  // Build helpers and the Fripon Cloud server run in Node, not in the browser.
  { files: ['scripts/**', 'server/**'], languageOptions: { globals: globals.node } },
);
