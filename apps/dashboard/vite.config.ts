import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * No proxy, no API, no backend.
 *
 * The viewer reads `public/snapshot.json`, which `adversary report` writes. A
 * dashboard that queried a live database would need a process listening on a
 * port, and nothing in this repository opens one.
 */
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true },
});
