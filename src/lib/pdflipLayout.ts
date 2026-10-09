import { CARD_H, CARD_W } from './goodnotes/model'

// Page geometry of PDFs made by PDFlip's "Goodnotes → PDF", shared with the importer so those
// PDFs can be turned back into decks at their original size.

/** Height of the "Deck · Card n of m · Question" band above a card. */
export const LABEL_BAND = 48
/** Space between question and answer in the one-page-per-card layout. */
export const CARD_GAP = 36
/** Inset of the grey card frame; the importer crops just inside it. */
export const FRAME_INSET = 6
const CROP_INSET = 8

export interface PdflipLayout {
  layout: 'pages' | 'stacked'
  labels: boolean
}

/** Crop of a page and where it goes on the card. Crop is in fractions of the page, target in card points. */
export interface CardRegion {
  crop: { x: number; y: number; w: number; h: number }
  target: { x: number; y: number; w: number; h: number }
}

function pageHeight(l: PdflipLayout): number {
  const band = l.labels ? LABEL_BAND : 0
  return l.layout === 'pages' ? band + CARD_H : 2 * (band + CARD_H) + CARD_GAP
}

const CANDIDATES: PdflipLayout[] = [
  { layout: 'pages', labels: true },
  { layout: 'pages', labels: false },
  { layout: 'stacked', labels: true },
  { layout: 'stacked', labels: false },
]

/** Recognises a PDF made by PDFlip from its page sizes (metadata is often lost when iOS re-saves it). */
export function detectPdflipLayout(sizes: { w: number; h: number }[]): PdflipLayout | null {
  if (sizes.length === 0) return null
  const near = (a: number, b: number) => Math.abs(a - b) < 1
  for (const l of CANDIDATES) {
    if (sizes.every((s) => near(s.w, CARD_W) && near(s.h, pageHeight(l)))) return l
  }
  return null
}

/** The card areas on a PDFlip page: one for 'pages', question then answer for 'stacked'. */
export function pdflipRegions(l: PdflipLayout): CardRegion[] {
  const band = l.labels ? LABEL_BAND : 0
  const H = pageHeight(l)
  const tops = l.layout === 'pages' ? [band] : [band, band + CARD_H + CARD_GAP + band]
  return tops.map((top) => ({
    crop: { x: CROP_INSET / CARD_W, y: (top + CROP_INSET) / H, w: (CARD_W - 2 * CROP_INSET) / CARD_W, h: (CARD_H - 2 * CROP_INSET) / H },
    target: { x: CROP_INSET, y: CROP_INSET, w: CARD_W - 2 * CROP_INSET, h: CARD_H - 2 * CROP_INSET },
  }))
}
