import { defineConfig } from 'vite';

export default defineConfig({
  // 相对 base：构建产物可直接部署到任意子路径
  base: './',
  server: {
    host: '127.0.0.1',
    port: 8123,
    open: false,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
});
