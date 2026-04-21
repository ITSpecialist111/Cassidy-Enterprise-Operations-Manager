import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served from /dashboard on the Cassidy webapp.
export default defineConfig({
  plugins: [react()],
  base: '/dashboard/',
  // Force a single copy of three across the whole bundle. Without dedup,
  // 3d-force-graph -> three-render-objects can pull a second copy and the
  // EffectComposer it returns won't accept passes built against our copy.
  resolve: {
    dedupe: ['three'],
  },
  build: { outDir: 'dist', sourcemap: false, target: 'es2022' },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3978',
      '/.auth': 'http://localhost:3978',
    },
  },
});
