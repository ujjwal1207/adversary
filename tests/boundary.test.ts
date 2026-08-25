/**
 * The dependency rule, tested.
 *
 * Everything in Adversary rests on one guarantee: the agent under test cannot
 * move money except through the interceptor. Not "should not" - cannot. That is
 * enforced in four layers (docs/ARCHITECTURE.md 5.2), and three of them are
 * checkable from here:
 *
 *   Layer 1  module resolution - packages/agents does not depend on
 *            @adversary/rails, so under pnpm's non-hoisted layout the import
 *            does not resolve at all
 *   Layer 2  lint - eslint no-restricted-imports, scoped to packages/agents
 *   Layer 3  import graph - no module under packages/agents/src names rails,
 *            directly or through a re-export
 *
 * Layer 4 (the frozen, null-prototype InterceptedTools object) is tested where
 * it is built: packages/runner/src/interceptor/__tests__/interceptor.test.ts.
 *
 * These are workspace-level invariants rather than package-level ones, which is
 * why they live in /tests instead of inside a package.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const FORBIDDEN_FOR_AGENTS = ['@adversary/rails', '@adversary/gate', '@adversary/runner'];

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkTs(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Every module specifier a file names, however it names it. */
function importSpecifiers(source: string): string[] {
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bexport\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g,
  ];
  const found: string[] = [];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) found.push(match[1]);
    }
  }
  return found;
}

// --- Layer 1: module resolution --------------------------------------------

describe('layer 1 - module resolution', () => {
  const agentsPkg = readJson(join(REPO_ROOT, 'packages/agents/package.json'));
  const deps = {
    ...((agentsPkg['dependencies'] as Record<string, string>) ?? {}),
    ...((agentsPkg['devDependencies'] as Record<string, string>) ?? {}),
    ...((agentsPkg['peerDependencies'] as Record<string, string>) ?? {}),
  };

  it.each(FORBIDDEN_FOR_AGENTS)(
    'packages/agents does not depend on %s',
    (forbidden) => {
      expect(Object.keys(deps)).not.toContain(forbidden);
    },
  );

  it('packages/agents depends on @adversary/core, for the contracts subpath only', () => {
    expect(Object.keys(deps)).toContain('@adversary/core');
  });

  it('@adversary/core exports only the root and the contracts subpath', () => {
    // The exports map is what makes "contracts only" enforceable rather than
    // aspirational: there is no third subpath for an agent to reach for.
    const corePkg = readJson(join(REPO_ROOT, 'packages/core/package.json'));
    expect(Object.keys(corePkg['exports'] as object).sort()).toEqual([
      '.',
      './contracts',
    ]);
  });
});

// --- Layer 2: lint ----------------------------------------------------------

describe('layer 2 - lint', () => {
  const eslint = new ESLint({ cwd: REPO_ROOT });
  const agentFile = join(REPO_ROOT, 'packages/agents/src/__lint_probe__.ts');
  const runnerFile = join(REPO_ROOT, 'packages/runner/src/__lint_probe__.ts');

  async function messagesFor(code: string, filePath: string) {
    const [result] = await eslint.lintText(code, { filePath });
    return result?.messages ?? [];
  }

  it.each(FORBIDDEN_FOR_AGENTS)(
    'flags an import of %s from packages/agents',
    async (forbidden) => {
      const messages = await messagesFor(
        `import { thing } from '${forbidden}';\nexport const x = thing;\n`,
        agentFile,
      );
      const restricted = messages.filter((m) => m.ruleId === 'no-restricted-imports');

      expect(restricted).toHaveLength(1);
      expect(restricted[0]?.message).toMatch(/interceptor-provided tools/);
    },
  );

  it('flags a deep import that reaches rails by relative path', async () => {
    const messages = await messagesFor(
      `import { MockRail } from '../../rails/src/mock.js';\nexport const x = MockRail;\n`,
      agentFile,
    );
    expect(messages.map((m) => m.ruleId)).toContain('no-restricted-imports');
  });

  it('flags a bare @adversary/core import from packages/agents', async () => {
    // Agents get types, not runtime values. A bare core import would hand an
    // agent the ledger and the evaluator.
    const messages = await messagesFor(
      `import { MONEY_KINDS } from '@adversary/core';\nexport const x = MONEY_KINDS;\n`,
      agentFile,
    );
    const restricted = messages.filter((m) => m.ruleId === 'no-restricted-imports');

    expect(restricted).toHaveLength(1);
    expect(restricted[0]?.message).toMatch(/contracts/);
  });

  it('permits @adversary/core/contracts from packages/agents', async () => {
    const messages = await messagesFor(
      `import type { MoneyKind } from '@adversary/core/contracts';\n` +
        `export type X = MoneyKind;\n`,
      agentFile,
    );
    expect(messages.filter((m) => m.ruleId === 'no-restricted-imports')).toHaveLength(0);
  });

  it('permits @adversary/rails from packages/runner - the composition root', async () => {
    const messages = await messagesFor(
      `import { thing } from '@adversary/rails';\nexport const x = thing;\n`,
      runnerFile,
    );
    expect(messages.filter((m) => m.ruleId === 'no-restricted-imports')).toHaveLength(0);
  });

  it('flags Math.random anywhere in the run path', async () => {
    const messages = await messagesFor(
      `export const x = Math.random();\n`,
      runnerFile,
    );
    const restricted = messages.filter((m) => m.ruleId === 'no-restricted-properties');

    expect(restricted).toHaveLength(1);
    expect(restricted[0]?.message).toMatch(/injected Rng/);
  });

  it('flags wall-clock reads anywhere in the run path', async () => {
    const now = await messagesFor(`export const x = Date.now();\n`, runnerFile);
    expect(now.map((m) => m.ruleId)).toContain('no-restricted-properties');

    const ctor = await messagesFor(`export const x = new Date();\n`, runnerFile);
    expect(ctor.map((m) => m.ruleId)).toContain('no-restricted-syntax');
    expect(ctor[0]?.message).toMatch(/injected Clock/);
  });
});

// --- Layer 3: import graph --------------------------------------------------

describe('layer 3 - import graph', () => {
  it('no module under packages/agents/src names rails, however it spells it', () => {
    const offenders: string[] = [];

    for (const file of walkTs(join(REPO_ROOT, 'packages/agents/src'))) {
      for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
        const reachesRails =
          specifier === '@adversary/rails' ||
          specifier.startsWith('@adversary/rails/') ||
          /(^|\/)rails(\/|$)/.test(specifier);

        if (reachesRails) {
          offenders.push(`${file.replace(REPO_ROOT, '.')} -> ${specifier}`);
        }
      }
    }

    // This catches what layers 1 and 2 cannot: a re-export laundered through
    // another module, or a relative path that sidesteps the package specifier.
    expect(offenders).toEqual([]);
  });

  it('packages/core imports nothing from the rest of the workspace', () => {
    // core is the domain layer. If it ever grows an edge to gate, rails,
    // runner or report, the layering in docs/ARCHITECTURE.md 4.2 is gone.
    const offenders: string[] = [];

    for (const file of walkTs(join(REPO_ROOT, 'packages/core/src'))) {
      for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
        if (specifier.startsWith('@adversary/')) {
          offenders.push(`${file.replace(REPO_ROOT, '.')} -> ${specifier}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('packages/core/src/contracts.ts compiles to no JavaScript at all', () => {
    // The claim in docs/ARCHITECTURE.md 5.1 is that an agent importing the
    // contracts subpath receives zero runtime code. Reading the source for
    // `export type` would only approximate that; compiling it and looking at
    // the output settles it. If someone adds a const, a function or an enum to
    // this file, the emitted module stops being empty and this fails.
    const source = readFileSync(
      join(REPO_ROOT, 'packages/core/src/contracts.ts'),
      'utf8',
    );

    const emitted = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        removeComments: true,
      },
    }).outputText;

    // `export {}` is TypeScript marking the file as a module. It declares no
    // value and is the only statement a types-only module may emit.
    const meaningful = emitted.replace(/export\s*\{\s*\}\s*;?/g, '').trim();

    expect(meaningful).toBe('');
  });

  it('packages/core/src/enums.ts does emit runtime code, and is not the agent subpath', () => {
    // The counterweight to the test above: the runtime companions genuinely
    // exist, they just live somewhere agents cannot import from.
    const source = readFileSync(join(REPO_ROOT, 'packages/core/src/enums.ts'), 'utf8');
    const emitted = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        removeComments: true,
      },
    }).outputText;

    expect(emitted).toContain('MONEY_KINDS');

    const corePkg = readJson(join(REPO_ROOT, 'packages/core/package.json'));
    expect(Object.keys(corePkg['exports'] as object)).not.toContain('./enums');
  });
});
