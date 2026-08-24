import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Lint is a load-bearing part of this architecture, not a style preference.
 *
 * Two rule groups below encode guarantees documented in docs/ARCHITECTURE.md:
 *
 *   1. The dependency rule (5.2) - packages/agents may not reach packages/rails.
 *      This is layer 2 of a four-layer defence; layer 1 is pnpm module
 *      resolution, layer 3 is the import-graph test, layer 4 is the frozen
 *      InterceptedTools object.
 *
 *   2. The determinism bans (9.1) - Math.random and wall-clock reads are
 *      forbidden, because the same scenario with the same seed must produce
 *      byte-identical ledgers. Components take an injected Rng and Clock.
 *      Files that legitimately provide those primitives opt out explicitly.
 */

const AGENTS_MAY_NOT_IMPORT_RAILS =
  'packages/agents may not import packages/rails. The only path from an agent ' +
  'to a payment rail is through interceptor-provided tools. See ' +
  'docs/ARCHITECTURE.md 5.2.';

const AGENTS_CONTRACTS_ONLY =
  'packages/agents may import only @adversary/core/contracts, which carries ' +
  'types and no runtime values. An agent must not be able to construct a ' +
  'ledger, an evaluator, or anything else in the trusted half of the system.';

const NO_MATH_RANDOM =
  'Math.random() breaks determinism (docs/ARCHITECTURE.md 9.1). Take an ' +
  'injected Rng instead.';

const NO_WALL_CLOCK =
  'Reading the wall clock breaks determinism (docs/ARCHITECTURE.md 9.3), and ' +
  'the gate velocity rule reads time - a security verdict must not depend on ' +
  'machine load. Take an injected Clock instead.';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/drizzle/**',
      'apps/dashboard/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: NO_MATH_RANDOM },
        { object: 'Date', property: 'now', message: NO_WALL_CLOCK },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: NO_WALL_CLOCK,
        },
      ],
    },
  },

  // --- Guarantee 1: the dependency rule ------------------------------------
  {
    files: ['packages/agents/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: '@adversary/rails', message: AGENTS_MAY_NOT_IMPORT_RAILS },
            { name: '@adversary/gate', message: AGENTS_MAY_NOT_IMPORT_RAILS },
            { name: '@adversary/runner', message: AGENTS_MAY_NOT_IMPORT_RAILS },
            { name: '@adversary/core', message: AGENTS_CONTRACTS_ONLY },
          ],
          patterns: [
            {
              group: ['@adversary/rails/*', '**/rails/**', '**/packages/rails/**'],
              message: AGENTS_MAY_NOT_IMPORT_RAILS,
            },
          ],
        },
      ],
    },
  },

  // --- Determinism opt-outs -------------------------------------------------
  // These files exist precisely to provide the primitives banned above. The
  // opt-out is narrow and per-file on purpose: it should be uncomfortable to
  // add one.
  {
    files: [
      'packages/core/src/determinism/system-clock.ts',
      'packages/rails/src/live-test/**/*.ts',
    ],
    rules: {
      'no-restricted-properties': 'off',
      'no-restricted-syntax': 'off',
    },
  },

  // Config files and migration scripts are tooling, not run-path code.
  {
    files: ['*.config.ts', '*.config.js', 'eslint.config.js', '**/migrate-cli.ts'],
    rules: {
      'no-restricted-properties': 'off',
      'no-restricted-syntax': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
