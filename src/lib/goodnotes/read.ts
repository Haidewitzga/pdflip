import JSZip from 'jszip'
import { readStream, tryParse, View } from '../pb'
import { decodeBv41 } from '../lz4'
import { uuidPlusOne } from '../uuid'
import type { CanvasImage, Card, Deck, RGBA, Side, Stroke, TextBox } from './model'

const STROKE_SIGNATURE = 'vuA(v)A(S(uu))A(S(uuuu))vA(f)'
const ascii = new TextDecoder('latin1')

type Clock = [bigint, bigint]
type Versioned = { clock: Clock; value: View }

function clockOf(v: View | null): Clock {
  return v ? [v.int(1) ?? 0n, v.int(2) ?? 0n] : [0n, 0n]
}

function newer(a: Clock, b: Clock): boolean {
  return a[0] > b[0] || (a[0] === b[0] && a[1] >= b[1])
}

interface CardState {
  order?: Versioned
  front?: Versioned
  back?: Versioned
}

/** Reads a flashcard deck from a .goodnotes file. */
export async function readDeck(file: ArrayBuffer | Uint8Array): Promise<Deck> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(file)
  } catch {
    throw new Error('This is not a .goodnotes file (it is not a zip archive).')
  }
  const read = async (name: string) => {
    const f = zip.file(name)
    return f ? f.async('uint8array') : undefined
  }
  const events = await read('index.events.pb')
  if (!events) throw new Error('This .goodnotes file has no event log (index.events.pb).')

  let title = 'Flashcards'
  const cards = new Map<string, CardState>()

  for (const m of readStream(events)) {
    const p = tryParse(m)
    if (!p) continue
    const body = p.find((x) => x.f !== 1)
    if (!body || body.t !== 2) continue
    const e = View.try(body.v)
    if (!e) continue
    if (body.f === 30) {
      title = e.msg(2)?.str(1) ?? title
    } else if (body.f === 151 || body.f === 152) {
      const id = e.str(1)
      if (!id) continue
      const state = cards.get(id) ?? {}
      cards.set(id, state)
      const slots: [keyof CardState, number][] =
        body.f === 151 ? [['order', 4], ['front', 5], ['back', 6]] : [['order', 3], ['front', 4], ['back', 5]]
      for (const [name, fld] of slots) {
        const b = e.bytes(fld)
        if (!b || b.length === 0) continue
        const value = View.try(b)
        if (!value) continue
        const clock = clockOf(value.msg(2))
        const cur = state[name]
        if (!cur || newer(clock, cur.clock)) state[name] = { clock, value }
      }
    }
  }

  if (cards.size === 0) throw new Error('No flashcards found in this file. Is it a flashcard deck?')

  const ordered = [...cards.values()].sort((a, b) => {
    const ka = a.order?.value.str(1) ?? ''
    const kb = b.order?.value.str(1) ?? ''
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })

  const out: Card[] = []
  for (const c of ordered) {
    out.push({ front: await readSide(c.front?.value, read), back: await readSide(c.back?.value, read) })
  }
  return { title, cards: out }
}

async function readSide(v: View | undefined, read: (n: string) => Promise<Uint8Array | undefined>): Promise<Side> {
  const content = v?.msg(1)
  if (!content) return { kind: 'text', text: '' }
  const canvasRef = content.msg(3)?.str(1)
  if (canvasRef) {
    const notes = await read('notes/' + uuidPlusOne(canvasRef))
    return readCanvas(notes ?? new Uint8Array(), read)
  }
  return { kind: 'text', text: content.msg(1)?.str(2) ?? '' }
}

async function readCanvas(data: Uint8Array, read: (n: string) => Promise<Uint8Array | undefined>): Promise<Side> {
  const deleted = new Set<string>()
  const elements: [number, View][] = []
  for (const m of data.length ? readStream(data) : []) {
    const p = tryParse(m)
    if (!p || p.length === 0) continue
    const first = p[0]
    if (first.f === 1 && first.t === 2 && first.v.length === 36) {
      // element header; field 3 = 1 marks an erased element
      const h = new View(p)
      if (h.int(3) === 1n) deleted.add(h.str(1)!)
      continue
    }
    if (first.t !== 2) continue
    const e = View.try(first.v)
    if (e) elements.push([first.f, e])
  }

  const strokes: Stroke[] = []
  const images: CanvasImage[] = []
  const texts: TextBox[] = []
  for (const [kind, e] of elements) {
    const id = e.str(1)
    if ((id && deleted.has(id)) || e.int(14) === 1n) continue
    if (kind === 7) {
      const s = readStroke(e)
      if (s) strokes.push(s)
    } else if (kind === 1 && e.has(4)) {
      const fr = frame(e.msg(2))
      const att = e.str(4)
      const bytes = att ? await read('attachments/' + att) : undefined
      if (fr && bytes) images.push({ ...fr, data: bytes })
    } else if (kind === 8) {
      const fr = frame(e.msg(2))
      const rtf = e.str(6)
      if (fr && rtf) {
        const scale = e.msg(4)?.num(1, 1) || 1
        texts.push({ ...fr, text: rtfToText(rtf), fontSize: rtfFontSize(rtf) * scale })
      }
    }
  }
  return { kind: 'canvas', strokes, images, texts }
}

function frame(v: View | null): { x: number; y: number; w: number; h: number } | null {
  const o = v?.msg(1)
  const s = v?.msg(2)
  if (!o || !s) return null
  return { x: o.num(1), y: o.num(2), w: s.num(1), h: s.num(2) }
}

function readStroke(e: View): Stroke | null {
  const blob = e.bytes(2)
  if (!blob) return null
  let raw: Uint8Array
  try {
    raw = decodeBv41(blob)
  } catch {
    return null
  }
  // "tpl\0" + u32 length + NUL-terminated type signature + payload
  const nul = raw.indexOf(0, 8)
  if (nul < 0 || ascii.decode(raw.subarray(8, nul)) !== STROKE_SIGNATURE) return null
  const h = raw.subarray(nul + 1)
  const dv = new DataView(h.buffer, h.byteOffset, h.byteLength)
  if (h.length < 10) return null
  const width = dv.getFloat32(2, true)
  const n = dv.getUint32(6, true)
  if (n === 0) return null
  // After the n path-element types comes a small count, then the start point and
  // the quadratic segments; locate it by checking that the lengths add up.
  let q = -1
  let m = 0
  for (let c = 10 + 2 * n; c < 10 + 2 * n + 12 && c + 12 <= h.length; c++) {
    const cand = dv.getUint32(c + 8, true)
    if (c + 12 + 16 * cand + 6 === h.length) {
      q = c
      m = cand
      break
    }
  }
  if (q < 0) return null
  const off = e.msg(6)
  const dx = off?.num(1) ?? 0
  const dy = off?.num(2) ?? 0
  const start: [number, number] = [dv.getFloat32(q, true) + dx, dv.getFloat32(q + 4, true) + dy]
  const segments: number[] = []
  for (let k = 0; k < m; k++) {
    const b = q + 12 + 16 * k
    segments.push(
      dv.getFloat32(b, true) + dx,
      dv.getFloat32(b + 4, true) + dy,
      dv.getFloat32(b + 8, true) + dx,
      dv.getFloat32(b + 12, true) + dy,
    )
  }
  if (!segments.every(Number.isFinite) || !start.every(Number.isFinite)) return null
  const col = e.msg(4)
  const color: RGBA = [col?.num(1) ?? 0, col?.num(2) ?? 0, col?.num(3) ?? 0, col?.num(4) || 1]
  return { color, width: width > 0 && Number.isFinite(width) ? width : 1.56, start, segments }
}

/** Extracts plain text from the simple RTF Goodnotes writes for text boxes. */
export function rtfToText(rtf: string): string {
  // Content starts after the last colour switch of the header.
  const marker = rtf.lastIndexOf('\\cf')
  let body = marker >= 0 ? rtf.slice(marker).replace(/^\\cf\d+ ?/, '') : rtf
  body = body
    .replace(/\\'([0-9a-f]{2})/gi, (_, h) => new TextDecoder('windows-1252').decode(new Uint8Array([parseInt(h, 16)])))
    .replace(/\\uc0\\u(-?\d+) ?/g, (_, d) => String.fromCharCode((Number(d) + 65536) % 65536))
    .replace(/\\u(-?\d+)\??/g, (_, d) => String.fromCharCode((Number(d) + 65536) % 65536))
    .replace(/\\\n/g, '\n')
    .replace(/\\par\b ?/g, '\n')
    .replace(/\\[a-z]+-?\d* ?/gi, '')
    .replace(/[{}]/g, '')
  return body.trim()
}

function rtfFontSize(rtf: string): number {
  const m = rtf.match(/\\fs(\d+)/)
  return m ? Number(m[1]) / 2 : 24
}
