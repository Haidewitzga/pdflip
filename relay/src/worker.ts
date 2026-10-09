// PDFlip problem-report relay (Cloudflare Worker).
//
// The website cannot create GitHub issues itself: the token would be visible to everyone. This
// worker holds the token, accepts reports only from the PDFlip site, checks them strictly, limits
// how often they can be sent, and turns each new problem into one GitHub issue. Later reports of
// the same problem add (at most) a short comment to that issue instead of opening another one.
//
// Secrets / variables (see docs/PROBLEM_REPORTS.md):
//   GITHUB_TOKEN     fine-grained token, repository Haidewitzga/pdflip, permission Issues: read & write
//   GITHUB_REPO      "Haidewitzga/pdflip"
//   ALLOWED_ORIGINS  comma-separated, e.g. "https://haidewitzga.github.io,http://localhost:5173"

export interface Env {
  GITHUB_TOKEN: string
  GITHUB_REPO: string
  ALLOWED_ORIGINS: string
}

/** Things the worker uses from its platform, replaceable in tests. */
export interface Deps {
  fetch: typeof fetch
  /** Counts events per key within a time window; returns the new count. */
  count: (key: string, windowSeconds: number) => Promise<number>
  now: () => Date
}

export const LIMITS = {
  bodyBytes: 16_000,
  reportsPerIpPerHour: 10,
  newIssuesPerHour: 10,
  /** At most one "reported again" comment per problem in this time. */
  commentEverySeconds: 6 * 3600,
  /** A problem reported again within this time after its issue was closed is not opened again. */
  closedGraceDays: 14,
}

const KINDS = ['missing-character-map', 'pdf-reader-warning', 'unsupported-characters', 'unreadable-part', 'unexpected-error'] as const
const AREAS = ['pdf-to-goodnotes', 'goodnotes-to-pdf'] as const
type Kind = (typeof KINDS)[number]
type Area = (typeof AREAS)[number]
type DetailValue = string | number | string[]

export interface Report {
  version: string
  browser: string
  problem: {
    area: Area
    kind: Kind
    signature: string
    title: string
    message: string
    details: Record<string, DetailValue>
  }
}

// ---------------------------------------------------------------------------------------------
// Validation: only known fields, plain short text, no markup that could break the issue.

const clean = (s: string, max: number) =>
  s
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[`<>]/g, "'")
    .replace(/@/g, '(at)')
    .trim()
    .slice(0, max)

function str(v: unknown, max: number, pattern?: RegExp): string | null {
  if (typeof v !== 'string' || v.length === 0 || v.length > max * 2) return null
  if (pattern && !pattern.test(v)) return null
  return clean(v, max)
}

/** Returns a cleaned report, or a reason why it is rejected. */
export function validateReport(input: unknown): Report | string {
  if (!input || typeof input !== 'object') return 'not a JSON object'
  const r = input as Record<string, unknown>
  if (r.schema !== 1 || r.app !== 'pdflip') return 'unknown schema'
  const version = str(r.version, 20, /^[\w.-]+$/)
  const browser = str(r.browser, 60)
  const p = r.problem as Record<string, unknown> | undefined
  if (!version || !browser || !p || typeof p !== 'object') return 'missing fields'
  if (!AREAS.includes(p.area as Area)) return 'unknown area'
  if (!KINDS.includes(p.kind as Kind)) return 'unknown kind'
  const signature = str(p.signature, 120, /^[a-z]+\.[a-z-]+:[a-z0-9.+-]+$/)
  const title = str(p.title, 140)
  const message = str(p.message, 300)
  if (!signature) return 'invalid signature'
  if (!title || !message) return 'missing title or message'
  const d = p.details
  if (!d || typeof d !== 'object' || Array.isArray(d)) return 'invalid details'
  const entries = Object.entries(d as Record<string, unknown>)
  if (entries.length > 20) return 'too many details'
  const details: Record<string, DetailValue> = {}
  for (const [k, v] of entries) {
    if (!/^[a-zA-Z][\w-]{0,40}$/.test(k)) return `invalid detail name ${k.slice(0, 40)}`
    if (typeof v === 'number' && Number.isFinite(v)) details[k] = v
    else if (typeof v === 'string' && v.length <= 600) details[k] = clean(v, 600)
    else if (Array.isArray(v) && v.length <= 50 && v.every((x) => typeof x === 'string' && x.length <= 200))
      details[k] = v.map((x) => clean(x, 200))
    else return `invalid detail ${k}`
  }
  return { version, browser, problem: { area: p.area as Area, kind: p.kind as Kind, signature, title, message, details } }
}

// ---------------------------------------------------------------------------------------------
// Issue text

const AREA_NAMES: Record<Area, string> = { 'pdf-to-goodnotes': 'PDF → Goodnotes', 'goodnotes-to-pdf': 'Goodnotes → PDF' }

/** Where to start, per kind of problem; read by the fixer routine. */
const HINTS: Record<Kind, string> = {
  'missing-character-map':
    'pdf.js asked for the character maps (CMaps) listed above while drawing the pages, and PDFlip ships none, so that text is missing from the cards. The app does not say which language this is; work it out from the map names (Adobe\'s predefined CMaps). Start in `src/lib/pdfToCards.ts` (`openPdf`, `RecordingCMapReader`). Reproduce with a PDF that uses a non-embedded CID font with one of these CMaps (e.g. reportlab `UnicodeCIDFont`).',
  'pdf-reader-warning':
    'pdf.js logged these warnings while reading or drawing the PDF and carried on without that part, so it is probably missing from the cards. Find the warning text in `node_modules/pdfjs-dist/build/pdf.worker.mjs` to see what pdf.js gave up on, then check whether a pdf.js option, a pdf.js update or PDFlip code can handle it. Start in `src/lib/pdfToCards.ts`. Numbers in the warnings are replaced by `n`.',
  'unsupported-characters':
    'No bundled font has glyphs for these characters (see the code points and blocks above; work out which writing system they belong to), so they are drawn as "?". Start in `src/lib/fonts.ts` (`FontBook`) and `public/fonts/`. Mind the size of any added font (the site is cached for offline use).',
  'unreadable-part':
    'The Goodnotes reader skipped a part it does not understand. `structure` is a fingerprint of it (element fields, ink type signature, first payload bytes). Start in `src/lib/goodnotes/read.ts` and `docs/FORMAT.md`. Without the user\'s file, reproduce with a hand-built element in the unit tests; if the fingerprint is not enough to decode it, say so on the issue and ask for a sample deck.',
  'unexpected-error':
    'An exception PDFlip does not expect. The stack lines name the bundled files of the version above (`git checkout <version>`, `npm run build`).',
}

export async function signatureHash(signature: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signature)))
  return Array.from(digest.slice(0, 6), (b) => b.toString(16).padStart(2, '0')).join('')
}

export const marker = (hash: string) => `pdflip-sig:${hash}`

export function issueTitle(r: Report): string {
  return `[auto-report] ${r.problem.title}`.slice(0, 200)
}

export function issueBody(r: Report, hash: string, date: Date): string {
  const p = r.problem
  const json = JSON.stringify({ version: r.version, browser: r.browser, ...p }, null, 2)
  return [
    '**Automatic problem report from PDFlip.** A user tapped “Send report” after PDFlip could not fully handle their file. The file itself is never sent; everything known is below.',
    '',
    '| | |',
    '|---|---|',
    `| Problem | ${p.title} |`,
    `| Area | ${AREA_NAMES[p.area]} |`,
    `| Kind | \`${p.kind}\` |`,
    `| PDFlip version | \`${r.version}\` |`,
    `| Browser | ${r.browser} |`,
    `| First reported | ${date.toISOString().slice(0, 10)} |`,
    '',
    '### What the user saw',
    '',
    `> ${p.message}`,
    '',
    '### Technical details',
    '',
    '```json',
    json,
    '```',
    '',
    '### Where to start',
    '',
    HINTS[p.kind],
    '',
    `<sub>Signature \`${p.signature}\` · ${marker(hash)}</sub>`,
  ].join('\n')
}

// ---------------------------------------------------------------------------------------------
// GitHub

interface Issue {
  number: number
  html_url: string
  body?: string | null
  state: string
  closed_at?: string | null
}

function github(env: Env, deps: Deps) {
  const headers = {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'pdflip-report-relay',
    'Content-Type': 'application/json',
  }
  const api = async (path: string, init: RequestInit = {}) => {
    const res = await deps.fetch(`https://api.github.com/repos/${env.GITHUB_REPO}${path}`, { ...init, headers })
    if (!res.ok) throw new Error(`GitHub ${init.method ?? 'GET'} ${path}: ${res.status}`)
    return res.json()
  }
  return {
    /** Open (or recently closed) auto-report issues carrying this signature. */
    async find(hash: string, state: 'open' | 'closed'): Promise<Issue | undefined> {
      const issues = (await api(`/issues?labels=auto-report&state=${state}&per_page=100&sort=updated`)) as Issue[]
      return issues.find((i) => i.body?.includes(marker(hash)))
    },
    create: (title: string, body: string, labels: string[]) =>
      api('/issues', { method: 'POST', body: JSON.stringify({ title, body, labels }) }) as Promise<Issue>,
    comment: (n: number, body: string) => api(`/issues/${n}/comments`, { method: 'POST', body: JSON.stringify({ body }) }),
  }
}

// ---------------------------------------------------------------------------------------------
// Request handling

function json(status: number, body: unknown, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
    },
  })
}

export async function handle(req: Request, env: Env, deps: Deps): Promise<Response> {
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  const origin = req.headers.get('Origin')
  const okOrigin = origin && allowed.includes(origin) ? origin : null
  const url = new URL(req.url)

  if (req.method === 'OPTIONS') {
    if (!okOrigin) return new Response(null, { status: 403 })
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': okOrigin,
        'Access-Control-Allow-Methods': 'POST',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      },
    })
  }
  if (url.pathname !== '/report') return json(404, { error: 'not found' }, okOrigin)
  if (req.method !== 'POST') return json(405, { error: 'use POST' }, okOrigin)
  if (!okOrigin) return json(403, { error: 'reports are only accepted from the PDFlip website' }, null)

  const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown'
  if ((await deps.count(`ip:${ip}`, 3600)) > LIMITS.reportsPerIpPerHour)
    return json(429, { error: 'Too many reports from this device. Please try again later.' }, okOrigin)

  const text = await req.text()
  if (text.length > LIMITS.bodyBytes) return json(413, { error: 'report too large' }, okOrigin)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return json(400, { error: 'invalid JSON' }, okOrigin)
  }
  const report = validateReport(parsed)
  if (typeof report === 'string') return json(400, { error: `invalid report: ${report}` }, okOrigin)

  const gh = github(env, deps)
  const hash = await signatureHash(report.problem.signature)
  const again = `Reported again by PDFlip \`${report.version}\` (${report.browser}).`
  try {
    // known problem: add a short note (rate-limited per problem) instead of a new issue
    const open = await gh.find(hash, 'open')
    const closed = open ? undefined : await gh.find(hash, 'closed')
    const recentlyClosed =
      closed?.closed_at && deps.now().getTime() - Date.parse(closed.closed_at) < LIMITS.closedGraceDays * 86_400_000
    const existing = open ?? (recentlyClosed ? closed : undefined)
    if (existing) {
      if ((await deps.count(`comment:${hash}`, LIMITS.commentEverySeconds)) === 1) {
        await gh.comment(existing.number, existing.state === 'closed' ? `${again} This issue is closed: the user may still have an older cached version, or the fix did not cover this case.` : again)
      }
      return json(200, { url: existing.html_url, duplicate: true }, okOrigin)
    }
    if ((await deps.count('new-issues', 3600)) > LIMITS.newIssuesPerHour)
      return json(429, { error: 'Many reports right now. Please try again later.' }, okOrigin)
    const issue = await gh.create(issueTitle(report), issueBody(report, hash, deps.now()), [
      'auto-report',
      `area:${report.problem.area}`,
      `kind:${report.problem.kind}`,
    ])
    return json(201, { url: issue.html_url, duplicate: false }, okOrigin)
  } catch (e) {
    console.error(e)
    return json(502, { error: 'Could not create the report on GitHub. Please try again later.' }, okOrigin)
  }
}

/**
 * Approximate counters in Cloudflare's per-location cache: good enough to stop floods, no extra
 * storage service or cost needed.
 */
async function cacheCount(key: string, windowSeconds: number): Promise<number> {
  const cache = (caches as unknown as { default: Cache }).default
  const bucket = Math.floor(Date.now() / 1000 / windowSeconds)
  const req = new Request(`https://pdflip-relay.internal/count/${encodeURIComponent(key)}/${bucket}`)
  const hit = await cache.match(req)
  const n = (hit ? Number(await hit.text()) : 0) + 1
  await cache.put(req, new Response(String(n), { headers: { 'Cache-Control': `max-age=${windowSeconds}` } }))
  return n
}

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, env, { fetch: (...a) => fetch(...a), count: cacheCount, now: () => new Date() })
  },
}
