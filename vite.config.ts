import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * Content Security Policy for the published site: the page may only load its own scripts, styles,
 * fonts and worker and may not send data anywhere. Only added to the build, since the dev server
 * injects inline scripts.
 */
const CSP = [
  "default-src 'self'",
  // WebAssembly (the SQLite engine for Anki decks) needs 'wasm-unsafe-eval'; it allows no JavaScript eval
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "worker-src 'self' blob:",
  "connect-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

function contentSecurityPolicy(): Plugin {
  return {
    name: 'content-security-policy',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }],
  }
}

/**
 * Writes sw.js, the service worker that keeps the site on the device for offline use. It lists every
 * built file, and its version is a hash of their contents, so each new build is picked up as an update.
 */
function serviceWorker(): Plugin {
  let outDir = 'dist'
  return {
    name: 'service-worker',
    apply: 'build',
    configResolved: (config) => {
      outDir = config.build.outDir
    },
    closeBundle: () => {
      const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]))
      const files = walk(outDir)
        .map((f) => relative(outDir, f).split(sep).join('/'))
        .filter((f) => f !== 'sw.js')
        .sort()
      const hash = createHash('sha256')
      for (const f of files) hash.update(f).update(readFileSync(join(outDir, f)))
      const sw = readFileSync('sw/sw.template.js', 'utf8')
        .replace('__VERSION__', `${Date.now().toString(36)}-${hash.digest('hex').slice(0, 12)}`)
        .replace('__FILES__', JSON.stringify(['./', ...files.filter((f) => f !== 'index.html'), 'index.html']))
      writeFileSync(join(outDir, 'sw.js'), sw)
    },
  }
}

// Served from https://<user>.github.io/pdflip/
export default defineConfig({
  base: '/pdflip/',
  plugins: [react(), contentSecurityPolicy(), serviceWorker()],
})
