import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Two builds from one codebase: the player UI (index.html) and the TV
// receiver UI (receiver.html), per PRD §9.1.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@pinpoint/shared': resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  build: {
    rollupOptions: {
      input: {
        player: resolve(__dirname, 'index.html'),
        receiver: resolve(__dirname, 'receiver.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/socket': { target: 'http://localhost:3001', ws: true },
      '/api': { target: 'http://localhost:3001' },
    },
  },
});
