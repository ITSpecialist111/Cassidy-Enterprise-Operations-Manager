import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Served from /dashboard on the Cassidy webapp.
export default defineConfig({
  plugins: [react()],
  base: '/dashboard/',
  build: { outDir: 'dist', sourcemap: false, target: 'es2022' },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3978',
      '/.auth': 'http://localhost:3978',
    },
  },
});
