import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: [
      '5173-iwoklo7xp5vwx1h5pxyzu-8f57ffe2.sandbox.novita.ai',
      '.sandbox.novita.ai'
    ]
  }
})
