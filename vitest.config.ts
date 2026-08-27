import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/cli/src/**/*.test.ts',
      // The viewer's tests are .tsx and need a DOM. Each declares
      // `@vitest-environment jsdom` in a docblock rather than switching the
      // whole suite: 940-odd tests that need no DOM should not pay for one.
      'apps/dashboard/src/**/*.test.tsx',
      // Workspace-level invariants (the dependency rule, the layering) belong
      // to the repository rather than to any one package.
      'tests/**/*.test.ts',
    ],
    environment: 'node',
    // A package with no tests is a phase that has not been built yet, not a
    // pass. Phases add their tests with their code.
    passWithNoTests: true,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/__fixtures__/**'],
    },
  },
});
