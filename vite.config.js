import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  // This handles the 'global is not defined' error
  define: {
    'global': 'self',
  },
  // This handles the 'stream', 'events', and 'util' module errors
  resolve: {
    alias: {
      stream: 'stream-browserify',
      events: 'events',
      util: 'util',
    },
  },
  
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        limited: resolve(__dirname, 'index-limited.html'),
      },
    },
  },
});