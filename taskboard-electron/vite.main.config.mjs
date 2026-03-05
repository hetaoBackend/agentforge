import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    watch: process.env.NODE_ENV === 'development' ? {} : null
  }
});
