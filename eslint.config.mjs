// ESLint for the sources (plain scripts concatenated by build.mjs into one function, so a
// top-level name of one file is visible in all of them), the tests and the build script.
import { readFileSync, readdirSync } from 'node:fs';
import globals from 'globals';
import js from '@eslint/js';

// Every top-level declaration of every source file: they share one scope once built.
const shared = {};
for (const f of readdirSync('src').filter((x) => x.endsWith('.js'))) {
  for (const m of readFileSync('src/' + f, 'utf8').matchAll(/^(?:async\s+)?(?:const|let|var|class|function\*?)\s+([A-Za-z_$][\w$]*)/gm)) shared[m[1]] = 'writable';
}

// A local may reuse a browser global's name (name, status, top...), never a name of this
// project: a local `t` hiding the translation function broke strings more than once.
const browserOnly = Object.keys(globals.browser).filter((k) => !(k in shared));

const rules = {
  'no-shadow': ['error', { builtinGlobals: true, hoist: 'functions', allow: browserOnly }],
  'no-unused-vars': ['error', { vars: 'local', args: 'none', caughtErrors: 'none' }],
  'no-var': 'error',
  'prefer-const': ['error', { destructuring: 'all' }],
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-implicit-globals': 'off',
  'no-empty': ['error', { allowEmptyCatch: true }],
};

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: { ...globals.browser, ...shared, Hls: 'readonly', GM_info: 'readonly', VERSION: 'readonly' },
    },
    rules: { ...rules, 'no-redeclare': 'off' },
  },
  {
    files: ['test/**/*.mjs', 'build.mjs', 'eslint.config.mjs'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node } },
    rules,
  },
];
