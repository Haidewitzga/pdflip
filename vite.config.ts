import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { execSync } from 'node:child_process'
import { reportUrl } from './src/site.config'

/** The problem-report relay: site.config.ts, or PDFLIP_REPORT_URL for test builds. */
const relayUrl = process.env.PDFLIP_REPORT_URL ?? reportUrl

/**
 * Content Security Policy for the published site: the page may only load its own scripts, styles,
 * fonts and worker and may not send data anywhere. Only added to the build, since the dev server
 * injects inline scripts.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "worker-src 'self' blob:",
  // the problem-report relay, when one is configured
  `connect-src 'self' data: blob:${relayUrl ? ' ' + new URL(relayUrl).origin : ''}`,
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

/** Short commit id of the build, shown in problem reports so a fix can find the exact code. */
function buildVersion(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7)
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return 'dev'
  }
}

// Served from https://<user>.github.io/pdflip/
export default defineConfig({
  base: '/pdflip/',
  plugins: [react(), contentSecurityPolicy(), serviceWorker()],
  define: { __PDFLIP_VERSION__: JSON.stringify(buildVersion()), __PDFLIP_REPORT_URL__: JSON.stringify(relayUrl) },
})
