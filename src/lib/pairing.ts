import type { CardSpec, SideSpec } from './pdfToCards'
import { pdflipRegions, type PdflipLayout } from './pdflipLayout'

export type Mode = 'alternate' | 'top-bottom' | 'manual'
export type Mark = 'Q' | 'A' | 'skip'

export const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: 'alternate', label: 'Page pairs', hint: 'Page 1 = question, page 2 = answer, page 3 = question, …' },
  { id: 'top-bottom', label: 'Top / bottom', hint: 'Each page is one card: top half = question, bottom half = answer.' },
  { id: 'manual', label: 'Mark pages', hint: 'Tap pages to cycle Question → Answer → Skip. Each question pairs with the next answer.' },
]

/** Default marks for a mode: alternating Q/A over the pages that are not skipped. */
export function autoMarks(pageCount: number, skipped: Set<number> = new Set()): Mark[] {
  const marks: Mark[] = []
  let q = true
  for (let p = 1; p <= pageCount; p++) {
    if (skipped.has(p)) marks.push('skip')
    else {
      marks.push(q ? 'Q' : 'A')
      q = !q
    }
  }
  return marks
}

export interface Pairing {
  cards: CardSpec[]
  /** Pages marked Q or A that did not end up in a card. */
  unpaired: number[]
}

/** Turns per-page marks (index 0 = page 1) into cards: each Q pairs with the next A. */
export function pairMarks(marks: Mark[]): Pairing {
  const cards: CardSpec[] = []
  const unpaired: number[] = []
  let pendingQ: number | null = null
  marks.forEach((m, i) => {
    const page = i + 1
    if (m === 'Q') {
      if (pendingQ !== null) unpaired.push(pendingQ)
      pendingQ = page
    } else if (m === 'A') {
      if (pendingQ === null) unpaired.push(page)
      else {
        cards.push({ front: { page: pendingQ }, back: { page } })
        pendingQ = null
      }
    }
  })
  if (pendingQ !== null) unpaired.push(pendingQ)
  return { cards, unpaired }
}

/** One card per page: top half = question, bottom half = answer. */
export function splitPages(pageCount: number, skipped: Set<number> = new Set()): CardSpec[] {
  const cards: CardSpec[] = []
  for (let page = 1; page <= pageCount; page++) {
    if (skipped.has(page)) continue
    cards.push({ front: { page, crop: { x: 0, y: 0, w: 1, h: 0.5 } }, back: { page, crop: { x: 0, y: 0.5, w: 1, h: 0.5 } } })
  }
  return cards
}

/**
 * For PDFs made by PDFlip: replace each side's crop with the exact card area of its page, so the
 * card comes back at its original size instead of shrinking the whole page (label band and frame
 * included) onto a new card. In the one-page-per-card layout the top card is the question.
 */
export function restorePdflipCards(cards: CardSpec[], layout: PdflipLayout): CardSpec[] {
  const regions = pdflipRegions(layout)
  const side = (s: SideSpec): SideSpec => {
    const r = regions.length === 1 ? regions[0] : regions[(s.crop?.y ?? 0) < 0.5 ? 0 : 1]
    return { page: s.page, crop: r.crop, target: r.target }
  }
  return cards.map((c) => ({ front: side(c.front), back: side(c.back) }))
}
