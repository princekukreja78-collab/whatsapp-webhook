import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/leads': 'http://127.0.0.1:10000',
      '/bots': 'http://127.0.0.1:10000',
      '/prompt': 'http://127.0.0.1:10000',
      '/send': 'http://127.0.0.1:10000',
      '/usedcars': 'http://127.0.0.1:10000',
      '/pricing': 'http://127.0.0.1:10000'
    }
  }
});
