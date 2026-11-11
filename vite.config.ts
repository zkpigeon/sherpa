import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: 'src/dashboard',
  plugins: [react()],
  // With VITE_DATA=http, dev talks to a sherpa-server on SHERPA_URL
  server: {
    host: '127.0.0.1',
    port: 5320,
    strictPort: true,
    proxy: Object.fromEntries(['/api', '/admin'].map((path) => [path, { target: process.env.SHERPA_URL ?? 'http://127.0.0.1:8080', changeOrigin: true }])),
  },
  build: { outDir: '../../dist/dashboard', emptyOutDir: true, target: 'es2022' },
})
