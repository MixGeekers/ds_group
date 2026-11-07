import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: 'web',
  publicDir: false,
  plugins: [react(), tailwindcss()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': process.env.DS_GROUP_CORE_URL || 'http://127.0.0.1:18100',
      '/.well-known/dscord': process.env.DS_GROUP_CORE_URL || 'http://127.0.0.1:18100',
    },
  },
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    target: 'es2022',
    license: { fileName: 'licenses/bundled-dependencies.txt' },
    manifest: true,
  },
});
