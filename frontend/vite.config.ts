import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    strictPort: true,
    proxy: {
      '/bootstrap': 'http://localhost:4891',
      '/agent': 'http://localhost:4891',
      '/agents': 'http://localhost:4891',
      '/file': 'http://localhost:4891',
      '/models': 'http://localhost:4891',
      '/saved-searches': 'http://localhost:4891',
    },
  },
})
