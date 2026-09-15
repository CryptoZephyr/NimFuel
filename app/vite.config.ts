import { defineConfig } from 'vite'

export default defineConfig({
  envPrefix: ['VITE_', 'PUBLIC_'],
  server: {
    host: true,
    port: 5173,
  },
})
