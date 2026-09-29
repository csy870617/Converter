import { defineConfig } from 'vite';

const isolation = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig({
  base: './', // GitHub Pages의 /저장소이름/ 아래에서도 동작하도록 상대 경로 사용
  server: { headers: isolation },
  preview: { headers: isolation },
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'] },
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 3000 },
});
