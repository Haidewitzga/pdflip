import JSZip from 'jszip'
import { readStream, tryParse, View } from '../pb'
import { decodeBv41 } from '../lz4'
import { uuidPlusOne } from '../uuid'
import { parseRtf } from '../rtf'
import type { CanvasImage, Card, Deck, FilledInk, RGBA, Side, Skipped, Stroke, TextBox } from './model'

const STROKE_SIGNATURE = 'vuA(v)A(S(uu))A(S(uuuu))vA(f)'
const OUTLINE_SIGNATURE = 'vuA(v)A(u)A(u)A(v)A(v)A(u)A(u)A(u)A(u)A(v)'
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
  deleted?: Versioned
  order?: Versioned
  front?: Versioned
  back?: Versioned
}

const MAX_ENTRIES = 100_000
const MAX_UNPACKED_BYTES = 2 * 1024 ** 3

/** Refuses archives that would unpack to far more than any real deck (a "zip bomb"). */
function checkArchiveSize(zip: JSZip) {
  const files = Object.values(zip.files)
  if (files.length > MAX_ENTRIES) throw new Error('This .goodnotes file has too many entries.')
  // JSZip keeps each entry's declared size from the zip directory here.
  const size = (f: JSZip.JSZipObject) => (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0
  const total = files.reduce((sum, f) => sum + size(f), 0)
  if (total > MAX_UNPACKED_BYTES) throw new Error('This .goodnotes file is too large to open.')
}

/** The image formats the PDF writer can embed. */
function imageFormatSupported(data: Uint8Array): boolean {
  const f = imageFormat(data)
  return f === 'PNG' || f === 'JPEG'
}

function imageFormat(data: Uint8Array): string {
  const at = (i: number, text: string) => [...text].every((c, k) => data[i + k] === c.charCodeAt(0))
  if (data[0] === 0x89 && at(1, 'PNG')) return 'PNG'
  if (data[0] === 0xff && data[1] === 0xd8) return 'JPEG'
  if (at(4, 'ftyp')) return 'HEIC'
  if (at(0, 'GIF8')) return 'GIF'
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'WebP'
  if (at(0, '%PDF')) return 'PDF'
  if (at(0, 'II*') || at(0, 'MM')) return 'TIFF'
  return 'unknown format'
}

/** Reads a flashcard deck from a .goodnotes file. */
export async function readDeck(file: ArrayBuffer | Uint8Array): Promise<Deck> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(file)
  } catch {
    throw new Error('This is not a .goodnotes file (it is not a zip archive).')
  }
  checkArchiveSize(zip)
  const read = async (name: string) => {
    const f = zip.file(name)
    return f ? f.async('uint8array') : undefined
  }
  const events = await read('index.events.pb')
  if (!events) throw new Error('This .goodnotes file has no event log (index.events.pb).')

  let title = 'Flashcards'
  let titleClock: Clock = [-1n, 0n]
  const cards = new Map<string, CardState>()

  for (const m of readStream(events)) {
    const p = tryParse(m)
    if (!p) continue
    const body = p.find((x) => x.f !== 1)
    if (!body || body.t !== 2) continue
    const e = View.try(body.v)
    if (!e) continue
    if (body.f === 30 || body.f === 31) {
      // 30 creates the document, 31 renames it; the newest clock wins
      const t = e.msg(2)
      const name = t?.str(1)
      const clock = clockOf(t?.msg(2) ?? null)
      if (name && newer(clock, titleClock)) {
        title = name
        titleClock = clock
      }
    } else if (body.f === 153) {
      // card deleted (or restored): {3: {1: 1 = deleted, 2: clock}}
      const id = e.str(1)
      const value = e.msg(3)
      if (!id || !value) continue
      const state = cards.get(id) ?? {}
      cards.set(id, state)
      const clock = clockOf(value.msg(2))
      if (!state.deleted || newer(clock, state.deleted.clock)) state.deleted = { clock, value }
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

  const live = [...cards.values()].filter((c) => c.deleted?.value.int(1) !== 1n && (c.front || c.back || c.order))
  if (live.length === 0) {
    throw new Error(
      'This Goodnotes file has no flashcards. PDFlip only converts flashcard decks. To turn a normal notebook into a PDF, use Share → Export → PDF in Goodnotes.',
    )
  }

  const ordered = live.sort((a, b) => {
    const ka = a.order?.value.str(1) ?? ''
    const kb = b.order?.value.str(1) ?? ''
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })

  const out: Card[] = []
  const skipped = new Map<string, Skipped>()
  for (const [i, c] of ordered.entries()) {
    const sides = (['question', 'answer'] as const).map((side) => {
      const skip: Skip = (what) => {
        const key = `${i}|${side}|${what}`
        const cur = skipped.get(key)
        if (cur) cur.count++
        else skipped.set(key, { card: i + 1, side, what, count: 1 })
      }
      return readSide((side === 'question' ? c.front : c.back)?.value, read, skip)
    })
    out.push({ front: await sides[0], back: await sides[1] })
  }
  return { title, cards: out, skipped: [...skipped.values()] }
}

/** Records one part of a card side that could not be read. */
type Skip = (what: string) => void

async function readSide(v: View | undefined, read: (n: string) => Promise<Uint8Array | undefined>, skip: Skip): Promise<Side> {
  const content = v?.msg(1)
  if (!content) return { kind: 'text', text: '' }
  const canvasRef = content.msg(3)?.str(1)
  if (canvasRef) {
    const notes = await read('notes/' + uuidPlusOne(canvasRef))
    return readCanvas(notes ?? new Uint8Array(), read, skip)
  }
  // Picture side: {2: {1: mime type, 2: attachment id}}
  const picture = content.msg(2)?.str(2)
  if (picture) {
    const data = await read('attachments/' + picture)
    if (!data) skip('image (file missing)')
    else if (!imageFormatSupported(data)) skip(`image (${imageFormat(data)})`)
    else return { kind: 'image', data }
    return { kind: 'text', text: '' }
  }
  const text = content.msg(1)?.str(2)
  if (text !== undefined || content.fields.length === 0 || (content.fields.length === 1 && content.has(1))) {
    return { kind: 'text', text: text ?? '' }
  }
  // A kind of card content we have not seen in an export yet
  skip('card side (unknown kind)')
  return { kind: 'text', text: '' }
}

async function readCanvas(data: Uint8Array, read: (n: string) => Promise<Uint8Array | undefined>, skip: Skip): Promise<Side> {
  const deleted = new Set<string>()
  /** Element id → attachment file named in its header (decks re-saved by Goodnotes use field 7). */
  const headerFiles = new Map<string, string>()
  const elements: [number, View][] = []
  for (const m of data.length ? readStream(data) : []) {
    const p = tryParse(m)
    if (!p || p.length === 0) continue
    const first = p[0]
    if (first.f === 1 && first.t === 2 && first.v.length === 36) {
      // element header; field 3 = 1 marks an erased element
      const h = new View(p)
      if (h.int(3) === 1n) deleted.add(h.str(1)!)
      const file = h.str(7)
      if (file) headerFiles.set(h.str(1)!, file)
      continue
    }
    if (first.t !== 2) continue
    const e = View.try(first.v)
    if (e) elements.push([first.f, e])
  }

  const strokes: Stroke[] = []
  const fills: FilledInk[] = []
  const images: CanvasImage[] = []
  const texts: TextBox[] = []
  for (const [index, [kind, e]] of elements.entries()) {
    const id = e.str(1)
    // Goodnotes layers elements by a counter (field 7 for ink, 5 for images and text boxes),
    // not by their position in the file; the file position only breaks ties.
    const layer = e.msg(kind === 7 ? 7 : 5)?.msg(1)?.int(1)
    const z = (layer !== undefined ? Number(layer) : 0) + index / 1e7
    if ((id && deleted.has(id)) || e.int(14) === 1n) continue
    if (kind === 7) {
      const s = readStroke(e)
      if (!s) skip('pen stroke')
      else if ('segments' in s) strokes.push({ ...s, z })
      else {
        if (s.fill) fills.push({ ...s.fill, z })
        strokes.push(...s.lines.map((l) => ({ ...l, z })))
      }
    } else if (kind === 1) {
      const fr = frame(e.msg(2))
      // Field 4 names the attachment in decks PDFlip wrote; after Goodnotes re-saves a deck it holds
      // an internal image id instead and the header's field 7 names the file.
      const att = e.str(4)
      const file = id ? headerFiles.get(id) : undefined
      const bytes = (att ? await read('attachments/' + att) : undefined) ?? (file ? await read('attachments/' + file) : undefined)
      if (!fr || !bytes) skip('image')
      else if (!imageFormatSupported(bytes)) skip(`image (${imageFormat(bytes)})`)
      else images.push({ ...fr, data: bytes, z })
    } else if (kind === 8) {
      const fr = frame(e.msg(2))
      const rtf = e.str(6)
      if (fr && rtf) {
        const scale = e.msg(4)?.num(1, 1) || 1
        const runs = parseRtf(rtf).map((r) => ({ ...r, size: r.size * scale }))
        texts.push({ ...fr, text: runs.map((r) => r.text).join(''), fontSize: (runs[0]?.size ?? 24 * scale), runs, z })
      } else skip('text box')
    } else {
      skip('item (unknown kind)')
    }
  }
  return { kind: 'canvas', strokes, fills, images, texts }
}

function frame(v: View | null): { x: number; y: number; w: number; h: number } | null {
  const o = v?.msg(1)
  const s = v?.msg(2)
  if (!o || !s) return null
  return { x: o.num(1), y: o.num(2), w: s.num(1), h: s.num(2) }
}

function strokeStyle(e: View) {
  const off = e.msg(6)
  const col = e.msg(4)
  const color: RGBA = [col?.num(1) ?? 0, col?.num(2) ?? 0, col?.num(3) ?? 0, col?.num(4) || 1]
  return { dx: off?.num(1) ?? 0, dy: off?.num(2) ?? 0, color }
}

function readStroke(e: View): Stroke | OutlineInk | null {
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
  if (nul < 0) return null
  const signature = ascii.decode(raw.subarray(8, nul))
  if (signature === OUTLINE_SIGNATURE) return readOutline(e, raw.subarray(nul + 1))
  if (signature !== STROKE_SIGNATURE) return null
  const h = raw.subarray(nul + 1)
  const dv = new DataView(h.buffer, h.byteOffset, h.byteLength)
  if (h.length < 10) return null
  const width = dv.getFloat32(2, true)
  const n = dv.getUint32(6, true)
  if (n === 0) return readShape(e)
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
  const { dx, dy, color } = strokeStyle(e)
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
  return { color, width: width > 0 && Number.isFinite(width) ? width : 1.56, start, segments }
}

/**
 * Strokes snapped to a shape have no ink payload; the shape is in field 9, with the pen width in
 * field 15 and one of:
 * - 1: polyline {1: point, 1: point, ...} (lines, arrows, triangles, rectangles)
 * - 2: arc {1: start, 2: a point halfway along, 3: end}
 * - 3: ellipse {1: centre, 2: width and height}
 */
function readShape(e: View): Stroke | null {
  const shape = e.msg(9)
  if (!shape) return null
  const { dx, dy, color } = strokeStyle(e)
  const pt = (v: View | null | undefined): [number, number] | null => (v ? [v.num(1) + dx, v.num(2) + dy] : null)
  const width = shape.num(15, 1.56)
  const style = { color, width: width > 0 ? width : 1.56 }
  const valid = (s: Stroke) => (s.start.every(Number.isFinite) && s.segments.every(Number.isFinite) ? s : null)

  const poly = shape.msg(1)
  if (poly) {
    const points: [number, number][] = []
    for (const f of poly.fields) {
      if (f.f !== 1 || f.t !== 2) continue
      const p = pt(View.try(f.v))
      if (p) points.push(p)
    }
    if (points.length < 2) return null
    const segments: number[] = []
    for (let k = 1; k < points.length; k++) {
      const [ax, ay] = points[k - 1]
      const [bx, by] = points[k]
      segments.push((ax + bx) / 2, (ay + by) / 2, bx, by) // straight segment as a degenerate quadratic
    }
    return valid({ ...style, start: points[0], segments })
  }

  const arc = shape.msg(2)
  if (arc) {
    const a = pt(arc.msg(1))
    const m = pt(arc.msg(2))
    const b = pt(arc.msg(3))
    if (!a || !m || !b) return null
    // the quadratic curve that passes through the middle point halfway along
    const c = [2 * m[0] - (a[0] + b[0]) / 2, 2 * m[1] - (a[1] + b[1]) / 2]
    return valid({ ...style, start: a, segments: [c[0], c[1], b[0], b[1]] })
  }

  const ellipse = shape.msg(3)
  if (ellipse) {
    const centre = pt(ellipse.msg(1))
    const size = ellipse.msg(2)
    if (!centre || !size) return null
    const [cx, cy] = centre
    const rx = size.num(1) / 2
    const ry = size.num(2) / 2
    // eight 45° quadratic segments; the control points sit at the corners of a circumscribed octagon
    const k = 1 / Math.cos(Math.PI / 8)
    const segments: number[] = []
    for (let i = 1; i <= 8; i++) {
      const mid = (i - 0.5) * (Math.PI / 4)
      const end = i * (Math.PI / 4)
      segments.push(cx + rx * k * Math.cos(mid), cy + ry * k * Math.sin(mid), cx + rx * Math.cos(end), cy + ry * Math.sin(end))
    }
    return valid({ ...style, start: [cx + rx, cy], segments })
  }
  return null
}

interface OutlineInk {
  /** Centre lines drawn with the pen (commands 0/1 of the first layer). */
  lines: Stroke[]
  /** Filled parts such as dots and arrowheads. */
  fill: FilledInk | null
}

/**
 * Ink stored with a second encoding (used e.g. for arrows and dots). The payload follows its type
 * signature with no padding: v, u (pen width, may be negative), then ten arrays (u32 count + items).
 *
 * Layer 1, arrays 1–3: commands (0 = move, x y from array 2; 1 = quadratic curve, cx cy x y from
 * array 3; 2 = dot start, x y width from array 2; 3 = dot curve, 6 values from array 3).
 * Layer 2, arrays 4–8: the filled outline of the dots: commands in array 5 (2 = start a subpath,
 * 4 = cubic curve), one start point per subpath in array 6 and curve points in array 8.
 */
function readOutline(e: View, h: Uint8Array): OutlineInk | null {
  const dv = new DataView(h.buffer, h.byteOffset, h.byteLength)
  const arrays: { u16?: number[]; f32?: number[] }[] = []
  let i = 6
  try {
    for (const t of ['v', 'u', 'u', 'v', 'v', 'u', 'u', 'u', 'u', 'v']) {
      const n = dv.getUint32(i, true)
      i += 4
      if (n > 1_000_000) return null
      if (t === 'v') {
        arrays.push({ u16: Array.from({ length: n }, (_, k) => dv.getUint16(i + 2 * k, true)) })
        i += 2 * n
      } else {
        arrays.push({ f32: Array.from({ length: n }, (_, k) => dv.getFloat32(i + 4 * k, true)) })
        i += 4 * n
      }
    }
  } catch {
    return null
  }
  if (i !== h.length) return null
  const { dx, dy, color } = strokeStyle(e)
  const lineWidth = Math.abs(dv.getFloat32(2, true))

  const lines: Stroke[] = []
  {
    const cmds = arrays[0].u16!
    const a = arrays[1].f32!
    const b = arrays[2].f32!
    let pa = 0
    let pb = 0
    let cur: Stroke | null = null
    for (const c of cmds) {
      if (c === 0) {
        if (pa + 2 > a.length) return null
        cur = { color, width: lineWidth > 0 ? lineWidth : 1.56, start: [a[pa] + dx, a[pa + 1] + dy], segments: [] }
        lines.push(cur)
        pa += 2
      } else if (c === 1) {
        if (!cur || pb + 4 > b.length) return null
        cur.segments.push(b[pb] + dx, b[pb + 1] + dy, b[pb + 2] + dx, b[pb + 3] + dy)
        pb += 4
      } else if (c === 2) {
        pa += 3
        cur = null
      } else if (c === 3) {
        pb += 6
      } else {
        return null
      }
    }
    if (pa !== a.length || pb !== b.length) return null
  }

  const commands = arrays[4].u16!
  const starts = arrays[5].f32!
  const points = arrays[7].f32!
  const arcs = arrays[8].f32!
  const arcFlags = arrays[9].u16!
  const subpaths: FilledInk['subpaths'] = []
  let s = 0
  let p = 0
  let a = 0
  for (const c of commands) {
    if (c === 2) {
      if (s + 2 > starts.length) return null
      subpaths.push({ start: [starts[s] + dx, starts[s + 1] + dy], curves: [] })
      s += 2
    } else if (c === 4) {
      const cur = subpaths[subpaths.length - 1]
      if (!cur || p + 6 > points.length) return null
      for (let k = 0; k < 6; k += 2) cur.curves.push(points[p + k] + dx, points[p + k + 1] + dy)
      p += 6
    } else if (c === 5) {
      // round cap: arc around (cx, cy) with radius r from angle a0 to a1, continuing from the current point
      const cur = subpaths[subpaths.length - 1]
      if (!cur || 5 * a + 5 > arcs.length) return null
      const [cx, cy, r, a0, a1] = arcs.slice(5 * a, 5 * a + 5)
      cur.curves.push(...arcCurves(cx + dx, cy + dy, r, a0, a1, arcFlags[a] !== 0))
      a++
    } else {
      return null // a command we have not seen yet
    }
  }
  if (!subpaths.every((sp) => sp.start.every(Number.isFinite) && sp.curves.every(Number.isFinite))) return null
  const finite = (st: Stroke) => st.start.every(Number.isFinite) && st.segments.every(Number.isFinite)
  return { lines: lines.filter(finite), fill: subpaths.length ? { color, subpaths } : null }
}

/**
 * A circular arc as cubic Bézier curves [c1x, c1y, c2x, c2y, x, y, ...]. With `decreasing` the angle runs
 * down from a0 to a1, otherwise up (angles in radians, y pointing down).
 */
function arcCurves(cx: number, cy: number, r: number, a0: number, a1: number, decreasing: boolean): number[] {
  let sweep = a1 - a0
  if (decreasing) while (sweep > 0) sweep -= 2 * Math.PI
  else while (sweep < 0) sweep += 2 * Math.PI
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-6))
  const step = sweep / n
  const k = (4 / 3) * Math.tan(step / 4) * r
  const out: number[] = []
  for (let i = 0; i < n; i++) {
    const t0 = a0 + i * step
    const t1 = t0 + step
    const [c0, s0, c1, s1] = [Math.cos(t0), Math.sin(t0), Math.cos(t1), Math.sin(t1)]
    out.push(cx + r * c0 - k * s0, cy + r * s0 + k * c0, cx + r * c1 + k * s1, cy + r * s1 - k * c1, cx + r * c1, cy + r * s1)
  }
  return out
}

/** Plain text of the RTF Goodnotes writes for text boxes. */
export function rtfToText(rtf: string): string {
  return parseRtf(rtf)
    .map((r) => r.text)
    .join('')
}
