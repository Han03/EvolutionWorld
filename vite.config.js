import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,  // Vite 8 oxc 压缩器会错误丢弃渲染器模块，禁用压缩
    rollupOptions: {
      input: {
        index: 'index.html',
        editor: 'editor.html',
      },
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
