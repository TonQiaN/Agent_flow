import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({ root: fileURLToPath(new URL('./client', import.meta.url)), build: { outDir: '../public', emptyOutDir: true }, server: { host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:3587' } } });
