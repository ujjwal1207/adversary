import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/contracts.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node20',
});
