import type { CardSpec } from './pdfToCards'

export type Mode = 'alternate' | 'top-bottom' | 'left-right' | 'manual'
export type Mark = 'Q' | 'A' | 'skip'

export const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: 'alternate', label: 'Page pairs', hint: 'Page 1 = question, page 2 = answer, page 3 = question, …' },
  { id: 'top-bottom', label: 'Top / bottom', hint: 'Each page is one card: top half = question, bottom half = answer.' },
  { id: 'left-right', label: 'Left / right', hint: 'Each page is one card: left half = question, right half = answer.' },
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

/** One card per page, split into two halves. */
export function splitPages(pageCount: number, mode: 'top-bottom' | 'left-right', skipped: Set<number> = new Set()): CardSpec[] {
  const cards: CardSpec[] = []
  for (let page = 1; page <= pageCount; page++) {
    if (skipped.has(page)) continue
    if (mode === 'top-bottom')
      cards.push({ front: { page, crop: { x: 0, y: 0, w: 1, h: 0.5 } }, back: { page, crop: { x: 0, y: 0.5, w: 1, h: 0.5 } } })
    else cards.push({ front: { page, crop: { x: 0, y: 0, w: 0.5, h: 1 } }, back: { page, crop: { x: 0.5, y: 0, w: 0.5, h: 1 } } })
  }
  return cards
}
