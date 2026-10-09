import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Served from https://<user>.github.io/pdflip/
export default defineConfig({
  base: '/pdflip/',
  plugins: [react()],
})
