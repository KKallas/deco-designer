import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'esnext', // top-level await for WebGPU renderer init
  },
});
