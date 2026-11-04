import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  publicDir: false,
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': process.env.DS_GROUP_CORE_URL || 'http://127.0.0.1:18100',
    },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    target: 'es2022',
    manifest: true,
  },
});
