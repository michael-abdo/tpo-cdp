import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// One Worker serves the SPA (static assets) and the Hono API (03 §A1 paragraph).
export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare()],
})
