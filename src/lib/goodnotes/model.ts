// In-memory representation of a Goodnotes flashcard deck.

/** Card canvas size in points, as used by Goodnotes' 16:10 card template. */
export const CARD_W = 1193.28
export const CARD_H = 745.8

export type RGBA = [number, number, number, number]

/** Drawing order on the canvas: higher values are drawn later, on top. */
interface Layered {
  z?: number
}

export interface Stroke extends Layered {
  color: RGBA
  width: number
  /** Start point followed by quadratic segments: [qx, qy, x, y, qx, qy, x, y, ...] */
  start: [number, number]
  segments: number[]
}

/** Ink stored as filled outlines: each subpath is a start point plus cubic curves [c1x, c1y, c2x, c2y, x, y, ...]. */
export interface FilledInk extends Layered {
  color: RGBA
  subpaths: { start: [number, number]; curves: number[] }[]
}

export interface CanvasImage extends Layered {
  x: number
  y: number
  w: number
  h: number
  data: Uint8Array
}

import type { TextRun } from '../rtf'

export interface TextBox extends Layered {
  x: number
  y: number
  w: number
  h: number
  text: string
  fontSize: number
  /** Styled pieces of the text (font family, bold, italic, size in canvas units, colour). */
  runs?: TextRun[]
}

export type Side =
  | { kind: 'text'; text: string }
  /** A picture used as the whole card side (Goodnotes' image button on a card). */
  | { kind: 'image'; data: Uint8Array }
  | { kind: 'canvas'; strokes: Stroke[]; fills: FilledInk[]; images: CanvasImage[]; texts: TextBox[] }

export interface Card {
  front: Side
  back: Side
}

/** Something on a card that PDFlip could not read and left out of the PDF. */
export interface Skipped {
  /** 1-based card number. */
  card: number
  side: 'question' | 'answer'
  /** What was left out, e.g. "pen stroke" or "image (HEIC)". */
  what: string
  count: number
  /** Technical fingerprint of the first such part, for problem reports (no card content). */
  detail?: string
}

export interface Deck {
  title: string
  cards: Card[]
  /** Parts of cards that could not be read. Empty when everything was understood. */
  skipped?: Skipped[]
}
