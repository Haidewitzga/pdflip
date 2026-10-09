// Problems PDFlip runs into while converting a file (things it cannot decode yet, unexpected errors)
// and the reports users can send about them with one tap. A report holds technical details only:
// names of formats and structures, Unicode code points, error messages. Never a file, an image or
// the text of a card. Reports become public GitHub issues (see relay/ and docs/PROBLEM_REPORTS.md).

import { repo } from '../site.config'
import type { Skipped } from './goodnotes/model'

export type Area = 'pdf-to-goodnotes' | 'goodnotes-to-pdf'
export type ProblemKind = 'missing-character-map' | 'unsupported-characters' | 'unreadable-part' | 'unexpected-error'
export type DetailValue = string | number | string[]

export interface Problem {
  area: Area
  kind: ProblemKind
  /** Stable id: the same problem from different users or files gets the same signature. */
  signature: string
  /** One line for the issue title. */
  title: string
  /** What the user is told. */
  message: string
  /** Technical details, safe to publish. */
  details: Record<string, DetailValue>
}

export interface Report {
  schema: 1
  app: 'pdflip'
  version: string
  browser: string
  problem: Problem
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9.+-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)

const codePoint = (ch: string) => 'U+' + ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')

// ---------------------------------------------------------------------------------------------
// Problem builders

/** Which writing system a PDF character map (CMap) is for, from its standard name. */
export function cmapScript(name: string): string {
  if (/GB|GBK|GBpc|GBT/.test(name)) return 'Simplified Chinese'
  if (/CNS|B5|ETen|HKscs|ETHK|HKdla|HKdlb|HKgccs|HKm/.test(name)) return 'Traditional Chinese'
  if (/KSC|UHC|Johab|UniKS|KSCms|KSCpc/.test(name)) return 'Korean'
  if (/JIS|RKSJ|EUC|90ms|90pv|83pv|Hankaku|Hiragana|Katakana|Roman|NWP|Add|Ext|^[HV]$/.test(name)) return 'Japanese'
  return 'other'
}

export function missingCharacterMapProblem(cmaps: string[], pdfjsVersion: string): Problem {
  const scripts = [...new Set(cmaps.map(cmapScript))].sort()
  const what = scripts.filter((s) => s !== 'other').join(', ') || 'non-Latin'
  return {
    area: 'pdf-to-goodnotes',
    kind: 'missing-character-map',
    signature: `pdf.missing-cmap:${slug(cmaps.join('+'))}`,
    title: `PDF text needs character maps PDFlip does not ship (${what})`,
    message: `This PDF contains ${what} text that PDFlip cannot display yet. That text will be missing from your cards.`,
    details: { characterMaps: cmaps, scripts, pdfjs: pdfjsVersion },
  }
}

const SCRIPTS: [string, RegExp][] = [
  ['Han (Chinese/Japanese kanji)', /\p{Script=Han}/u],
  ['Hiragana', /\p{Script=Hiragana}/u],
  ['Katakana', /\p{Script=Katakana}/u],
  ['Hangul (Korean)', /\p{Script=Hangul}/u],
  ['Arabic', /\p{Script=Arabic}/u],
  ['Hebrew', /\p{Script=Hebrew}/u],
  ['Devanagari', /\p{Script=Devanagari}/u],
  ['Thai', /\p{Script=Thai}/u],
  ['Emoji', /\p{Extended_Pictographic}/u],
]

const scriptOf = (ch: string) => SCRIPTS.find(([, re]) => re.test(ch))?.[0] ?? 'other'

export function unsupportedCharactersProblem(chars: string[]): Problem {
  const scripts = [...new Set(chars.map(scriptOf))].sort()
  const what = scripts.join(', ')
  return {
    area: 'goodnotes-to-pdf',
    kind: 'unsupported-characters',
    signature: `gn.unsupported-chars:${slug(scripts.join('+'))}`,
    title: `Card text has characters no bundled font can show (${what})`,
    message: `Some characters in your cards (${what}) cannot be shown by PDFlip's fonts yet. They appear as "?" in the PDF.`,
    // a few code points are enough to reproduce; the full text of the cards is never sent
    details: { scripts, distinctCharacters: chars.length, examples: chars.slice(0, 3).map(codePoint) },
  }
}

/** "1 image (HEIC)", "2 images (HEIC)", "3 text boxes": pluralises the noun before any "(…)" note. */
export function countOf(n: number, what: string): string {
  if (n === 1) return `1 ${what}`
  const [noun, ...rest] = what.split(' (')
  return `${n} ${noun}${/(s|x)$/.test(noun) ? 'es' : 's'}${rest.length ? ' (' + rest.join(' (') : ''}`
}

const withArticle = (what: string) => `${/^[aeiou]/i.test(what) ? 'an' : 'a'} ${what}`

export function unreadablePartProblems(skipped: Skipped[]): Problem[] {
  const byKind = new Map<string, { what: string; detail?: string; count: number; cards: number }>()
  for (const s of skipped) {
    // the ink type signature tells different unknown formats apart
    const variant = s.detail?.match(/signature=([^;]+)/)?.[1] ?? s.detail?.match(/kind=(\d+)/)?.[1] ?? ''
    const key = `${s.what}|${variant}`
    const cur = byKind.get(key)
    if (cur) {
      cur.count += s.count
      cur.cards++
    } else byKind.set(key, { what: s.what, detail: s.detail, count: s.count, cards: 1 })
  }
  return [...byKind.entries()].map(([key, p]) => ({
    area: 'goodnotes-to-pdf' as const,
    kind: 'unreadable-part' as const,
    signature: `gn.unreadable:${slug(key)}`,
    title: `Deck contains ${withArticle(p.what)} PDFlip cannot read`,
    message: `${countOf(p.count, p.what)} could not be read and ${p.count === 1 ? 'is' : 'are'} missing from the PDF.`,
    details: { part: p.what, occurrences: p.count, cardSides: p.cards, ...(p.detail ? { structure: p.detail } : {}) },
  }))
}

/** Our own messages for wrong or unsupported files are plain `Error`s; anything else is a bug. */
export function isUnexpected(e: unknown): boolean {
  return !(e instanceof Error) || e.constructor !== Error || e.name !== 'Error'
}

export function unexpectedErrorProblem(area: Area, stage: string, e: unknown, technical?: string): Problem {
  const err = e instanceof Error ? e : new Error(String(e))
  const message = (technical ?? `${err.name}: ${err.message}`).slice(0, 300)
  // keep file names and line numbers of the stack, not the site's address
  const stack = (err.stack ?? '')
    .split('\n')
    .slice(0, 8)
    .map((l) => l.replace(/https?:\/\/[^\s)]*\/([^/\s)]+)/g, '$1').trim().slice(0, 160))
    .filter(Boolean)
  return {
    area,
    kind: 'unexpected-error',
    signature: `${area === 'pdf-to-goodnotes' ? 'pdf' : 'gn'}.error:${slug(stage + '-' + message.replace(/\d+/g, 'n'))}`,
    title: `Unexpected error while ${stage}: ${message.slice(0, 80)}`,
    message: 'PDFlip ran into an unexpected error.',
    details: { stage, error: message, ...(stack.length ? { stack } : {}) },
  }
}

// ---------------------------------------------------------------------------------------------
// Sending

declare const __PDFLIP_VERSION__: string
declare const __PDFLIP_REPORT_URL__: string
export const VERSION = typeof __PDFLIP_VERSION__ === 'string' ? __PDFLIP_VERSION__ : 'dev'
/** The relay that turns reports into GitHub issues (site.config.ts, set at build time). */
export const REPORT_URL = typeof __PDFLIP_REPORT_URL__ === 'string' ? __PDFLIP_REPORT_URL__ : ''

/** "Safari 18 on iPad": browser family, major version and device type only. */
export function browserSummary(ua = navigator.userAgent, touchPoints = navigator.maxTouchPoints ?? 0): string {
  const os = /iPad/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1)
    ? 'iPad'
    : /iPhone/.test(ua)
      ? 'iPhone'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(ua)
            ? 'Mac'
            : /Linux/.test(ua)
              ? 'Linux'
              : 'other'
  const names: Record<string, string> = { Edg: 'Edge', FxiOS: 'Firefox', CriOS: 'Chrome' }
  // Edge and Chrome on iOS also mention "Chrome" or "Safari", so the order matters
  for (const name of ['Edg', 'FxiOS', 'Firefox', 'CriOS', 'Chrome']) {
    const m = ua.match(new RegExp(`${name}/(\\d+)`))
    if (m) return `${names[name] ?? name} ${m[1]} on ${os}`
  }
  const safari = ua.match(/Version\/(\d+).*Safari/)
  return safari ? `Safari ${safari[1]} on ${os}` : `unknown browser on ${os}`
}

export function makeReport(problem: Problem): Report {
  return { schema: 1, app: 'pdflip', version: VERSION, browser: browserSummary(), problem }
}

export type SendResult = { ok: true; url?: string; duplicate?: boolean } | { ok: false; error: string }

/** Sends a report to the relay, which turns it into a GitHub issue (or a +1 on an existing one). */
export async function sendReport(report: Report): Promise<SendResult> {
  if (!REPORT_URL) return { ok: false, error: 'Reporting is not set up on this site.' }
  try {
    const res = await fetch(`${REPORT_URL.replace(/\/$/, '')}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    })
    const body = (await res.json().catch(() => ({}))) as { url?: string; duplicate?: boolean; error?: string }
    if (!res.ok) return { ok: false, error: body.error ?? `The report service answered ${res.status}.` }
    return { ok: true, url: body.url, duplicate: body.duplicate }
  } catch {
    return { ok: false, error: 'Could not reach the report service. Are you offline?' }
  }
}

/** A pre-filled "new issue" page on GitHub, as a fallback (needs a GitHub account). */
export function githubIssueLink(report: Report): string {
  const body = [
    'Problem report from PDFlip (filled in automatically, technical details only):',
    '',
    '```json',
    JSON.stringify(report, null, 2).slice(0, 5000),
    '```',
  ].join('\n')
  const q = new URLSearchParams({ title: `[auto-report] ${report.problem.title}`.slice(0, 200), body })
  return `https://github.com/${repo}/issues/new?${q}`
}
