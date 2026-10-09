import { describe, expect, it } from 'vitest'
import { handle, issueBody, LIMITS, marker, signatureHash, validateReport, type Deps, type Env } from '../src/worker'

const env: Env = { GITHUB_TOKEN: 't0ken', GITHUB_REPO: 'Haidewitzga/pdflip', ALLOWED_ORIGINS: 'https://haidewitzga.github.io' }
const ORIGIN = 'https://haidewitzga.github.io'

const report = (over: Record<string, unknown> = {}) => ({
  schema: 1,
  app: 'pdflip',
  version: '7eb2384',
  browser: 'Safari 18 on iPad',
  problem: {
    area: 'pdf-to-goodnotes',
    kind: 'missing-character-map',
    signature: 'pdf.missing-cmap:unigb-ucs2-h',
    title: 'PDF text needs character maps PDFlip does not ship (Simplified Chinese)',
    message: 'This PDF contains Simplified Chinese text that PDFlip cannot display yet.',
    details: { characterMaps: ['UniGB-UCS2-H'], scripts: ['Simplified Chinese'], pdfjs: '4.10.38' },
    ...over,
  },
})

/** A fake GitHub API that keeps issues in memory, and in-memory counters. */
function fakes(issues: { number: number; body: string; state: string; closed_at?: string }[] = []) {
  const calls: { method: string; path: string; body?: unknown }[] = []
  const counters = new Map<string, number>()
  const deps: Deps = {
    now: () => new Date('2026-10-09T12:00:00Z'),
    count: async (key) => {
      const n = (counters.get(key) ?? 0) + 1
      counters.set(key, n)
      return n
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(String(input))
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ method, path: u.pathname + u.search, body })
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer t0ken')
      if (method === 'GET') {
        const state = u.searchParams.get('state')
        const list = issues.filter((i) => i.state === state).map((i) => ({ ...i, html_url: `https://github.com/x/issues/${i.number}` }))
        return new Response(JSON.stringify(list))
      }
      if (u.pathname.endsWith('/issues')) {
        const n = 100 + issues.length
        issues.push({ number: n, body: body.body, state: 'open' })
        return new Response(JSON.stringify({ number: n, html_url: `https://github.com/x/issues/${n}`, state: 'open' }), { status: 201 })
      }
      return new Response('{}', { status: 201 })
    }) as typeof fetch,
  }
  return { deps, calls, issues, counters }
}

const post = (body: unknown, origin: string | null = ORIGIN, ip = '1.2.3.4') =>
  new Request('https://relay.example/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, ...(origin ? { Origin: origin } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

describe('report relay', () => {
  it('creates one labelled issue for a new problem', async () => {
    const f = fakes()
    const res = await handle(post(report()), env, f.deps)
    expect(res.status).toBe(201)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)
    expect(await res.json()).toEqual({ url: 'https://github.com/x/issues/100', duplicate: false })
    const created = f.calls.find((c) => c.method === 'POST')!
    expect(created.path).toBe('/repos/Haidewitzga/pdflip/issues')
    const issue = created.body as { title: string; body: string; labels: string[] }
    expect(issue.title).toBe('[auto-report] PDF text needs character maps PDFlip does not ship (Simplified Chinese)')
    expect(issue.labels).toEqual(['auto-report', 'area:pdf-to-goodnotes', 'kind:missing-character-map'])
    expect(issue.body).toContain('UniGB-UCS2-H')
    expect(issue.body).toContain(marker(await signatureHash('pdf.missing-cmap:unigb-ucs2-h')))
  })

  it('adds a comment to the open issue instead of opening a second one, at most once per period', async () => {
    const hash = await signatureHash('pdf.missing-cmap:unigb-ucs2-h')
    const f = fakes([{ number: 7, body: `... ${marker(hash)}`, state: 'open' }])
    for (let i = 0; i < 3; i++) {
      const res = await handle(post(report(), ORIGIN, `10.0.0.${i}`), env, f.deps)
      expect(await res.json()).toEqual({ url: 'https://github.com/x/issues/7', duplicate: true })
    }
    const writes = f.calls.filter((c) => c.method === 'POST')
    expect(writes.map((w) => w.path)).toEqual(['/repos/Haidewitzga/pdflip/issues/7/comments'])
  })

  it('does not reopen a problem closed in the last two weeks', async () => {
    const hash = await signatureHash('pdf.missing-cmap:unigb-ucs2-h')
    const f = fakes([{ number: 8, body: marker(hash), state: 'closed', closed_at: '2026-10-05T00:00:00Z' }])
    const res = await handle(post(report()), env, f.deps)
    expect(await res.json()).toMatchObject({ duplicate: true })
    const comment = f.calls.find((c) => c.method === 'POST')!.body as { body: string }
    expect(comment.body).toContain('This issue is closed')
  })

  it('accepts reports only from the PDFlip website', async () => {
    const f = fakes()
    expect((await handle(post(report(), 'https://evil.example'), env, f.deps)).status).toBe(403)
    expect((await handle(post(report(), null), env, f.deps)).status).toBe(403)
    expect(f.calls).toHaveLength(0)
  })

  it('limits reports per device', async () => {
    const f = fakes()
    const statuses: number[] = []
    for (let i = 0; i <= LIMITS.reportsPerIpPerHour; i++) statuses.push((await handle(post(report()), env, f.deps)).status)
    expect(statuses.at(-1)).toBe(429)
  })

  it('rejects malformed or oversized reports before calling GitHub', async () => {
    const f = fakes()
    expect((await handle(post('{not json'), env, f.deps)).status).toBe(400)
    expect((await handle(post(report({ kind: 'steal-tokens' })), env, f.deps)).status).toBe(400)
    expect((await handle(post(report({ signature: 'x y z' })), env, f.deps)).status).toBe(400)
    expect((await handle(post('x'.repeat(LIMITS.bodyBytes + 1)), env, f.deps)).status).toBe(413)
    expect(f.calls).toHaveLength(0)
  })

  it('answers the browser preflight for allowed origins only', async () => {
    const pre = (origin: string) => new Request('https://relay.example/report', { method: 'OPTIONS', headers: { Origin: origin } })
    const ok = await handle(pre(ORIGIN), env, fakes().deps)
    expect(ok.status).toBe(204)
    expect(ok.headers.get('Access-Control-Allow-Methods')).toBe('POST')
    expect((await handle(pre('https://evil.example'), env, fakes().deps)).status).toBe(403)
  })
})

describe('report validation', () => {
  it('neutralises markup, mentions and code fences in text', () => {
    const r = validateReport(report({ title: 'Hi @octocat <img src=x> ```break```', details: { note: '@team <b>' } }))
    expect(typeof r).toBe('object')
    const v = r as Exclude<typeof r, string>
    expect(v.problem.title).toBe("Hi (at)octocat 'img src=x' '''break'''")
    expect(v.problem.details.note).toBe("(at)team 'b'")
    expect(issueBody(v, 'abc', new Date())).not.toContain('<img')
  })

  it('drops unknown fields and rejects wrong types', () => {
    const r = validateReport({ ...report(), token: 'x', problem: { ...report().problem, extra: 1 } }) as Exclude<ReturnType<typeof validateReport>, string>
    expect(Object.keys(r)).toEqual(['version', 'browser', 'problem'])
    expect(Object.keys(r.problem)).not.toContain('extra')
    expect(validateReport(report({ details: { nested: { a: 1 } } }))).toBe('invalid detail nested')
    expect(validateReport({ ...report(), schema: 2 })).toBe('unknown schema')
  })
})
