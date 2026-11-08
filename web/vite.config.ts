import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The API runs on :4000. Proxying keeps everything same-origin so the auth cookie just works.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:4000',
      '/socket.io': { target: 'http://localhost:4000', ws: true },
    },
  },
})
