import { defineConfig } from 'tsup';

export default defineConfig({
  // `money` is a separate entry so a browser can import it without pulling
  // in `canonical.ts`, which needs node:crypto. The viewer must format money
  // with the same function the report uses, not with a second implementation.
  entry: ['src/index.ts', 'src/contracts.ts', 'src/money.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
});
