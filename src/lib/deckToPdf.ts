import { PDFDocument, PDFImage, PDFPage, rgb } from 'pdf-lib'
import { FontBook, PLAIN, type FontStyle } from './fonts'
import { CARD_GAP, FRAME_INSET, LABEL_BAND } from './pdflipLayout'
import { CARD_H, CARD_W, type CanvasImage, type Deck, type FilledInk, type Side, type Stroke, type TextBox } from './goodnotes/model'

export type PdfLayout = 'pages' | 'stacked'

export interface PdfOptions {
  /** 'pages': question page then answer page. 'stacked': question above answer on one page. */
  layout: PdfLayout
  /** Prints "Deck · Card n of m · Question" in a band above each card. */
  labels: boolean
  /** Called after each card with (cards done, total), and with (total, total) before the file is written. */
  onProgress?: (done: number, total: number) => void
  /**
   * Optional fast path for images, e.g. re-encoding PNGs as JPEGs in the browser.
   * PNG decoding inside pdf-lib is slow for large images.
   */
  convertImage?: (data: Uint8Array) => Promise<Uint8Array | null>
  /**
   * Loads a TrueType font covering Greek, maths and other symbols. Only called when the deck has
   * text the built-in PDF font cannot show (e.g. θ, Ω, ∑); without it such characters become "?".
   */
  loadUnicodeFont?: () => Promise<Uint8Array>
  /** Called once with the characters no available font could show (drawn as "?"), if there are any. */
  onUnsupportedCharacters?: (chars: string[]) => void
}

/** Lets the browser repaint (progress, spinners) between chunks of work. */
const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0))


/** Renders a flashcard deck to a PDF. */
export async function deckToPdf(deck: Deck, opts: PdfOptions): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(deck.title)
  pdf.setCreator('PDFlip')
  const fonts = new FontBook(pdf, opts.loadUnicodeFont)
  const images = new Map<Uint8Array, PDFImage | null>()
  const embed = async (data: Uint8Array) => {
    if (!images.has(data)) {
      const converted = opts.convertImage ? await opts.convertImage(data).catch(() => null) : null
      images.set(data, await embedImage(pdf, converted ?? data))
    }
    return images.get(data)!
  }

  const band = opts.labels ? LABEL_BAND : 0
  const total = deck.cards.length
  for (const [i, card] of deck.cards.entries()) {
    const label = (what: string) => `${deck.title}  ·  Card ${i + 1} of ${total}  ·  ${what}`
    if (opts.layout === 'pages') {
      for (const [side, what] of [[card.front, 'Question'], [card.back, 'Answer']] as const) {
        const page = pdf.addPage([CARD_W, CARD_H + band])
        if (opts.labels) await drawLabel(page, fonts, label(what), CARD_H + band)
        await drawCard(page, fonts, side, 0, CARD_H, 1, embed)
      }
    } else {
      const h = band + CARD_H + CARD_GAP + band + CARD_H
      const page = pdf.addPage([CARD_W, h])
      let top = h
      for (const [side, what] of [[card.front, 'Question'], [card.back, 'Answer']] as const) {
        if (opts.labels) await drawLabel(page, fonts, label(what), top)
        top -= band
        await drawCard(page, fonts, side, 0, top, 1, embed)
        top -= CARD_H + CARD_GAP
      }
    }
    opts.onProgress?.(i + 1, total)
    await yieldToUi()
  }
  if (fonts.unsupported.size > 0) opts.onUnsupportedCharacters?.([...fonts.unsupported])
  return pdf.save()
}

async function drawLabel(page: PDFPage, fonts: FontBook, text: string, top: number) {
  let x = 24
  for (const seg of await fonts.segments(text, PLAIN)) {
    page.drawText(seg.text, { x, y: top - 32, size: 16, font: seg.font, color: rgb(0.45, 0.45, 0.5) })
    x += seg.font.widthOfTextAtSize(seg.text, 16)
  }
}

type Embed = (data: Uint8Array) => Promise<PDFImage | null>

/** Draws one card side with its top-left corner at (x, top) in PDF coordinates. */
async function drawCard(page: PDFPage, fonts: FontBook, side: Side, x: number, top: number, scale: number, embed: Embed) {
  const W = CARD_W * scale
  const H = CARD_H * scale
  page.drawRectangle({
    x: x + FRAME_INSET,
    y: top - H + FRAME_INSET,
    width: W - 2 * FRAME_INSET,
    height: H - 2 * FRAME_INSET,
    color: rgb(1, 1, 1),
    borderColor: rgb(0.85, 0.85, 0.88),
    borderWidth: 2,
  })

  if (side.kind === 'image') {
    const img = await embed(side.data)
    if (img) {
      const m = 24 * scale
      const k = Math.min((W - 2 * m) / img.width, (H - 2 * m) / img.height)
      const w = img.width * k
      const h = img.height * k
      page.drawImage(img, { x: x + (W - w) / 2, y: top - (H + h) / 2, width: w, height: h })
    }
    return
  }

  if (side.kind === 'text') {
    await drawCentredText(page, fonts, side.text, x + W / 2, top - H / 2, W - 160 * scale, 48 * scale)
    return
  }

  await drawInk(page, side, x, top, scale, embed)

  // Text boxes go on top of everything else.
  for (const t of side.texts) await drawTextBox(page, fonts, t, x, top, scale)
}

interface Word {
  text: string
  style: FontStyle
  size: number
  color: [number, number, number]
  width: number
  space: boolean
}

/**
 * Draws a text box with its fonts, bold/italic, sizes and colours, wrapping lines at the box width
 * like Goodnotes does. Fonts are the closest standard PDF fonts (see FontBook).
 */
async function drawTextBox(page: PDFPage, fonts: FontBook, t: TextBox, x: number, top: number, scale: number) {
  const runs = t.runs?.length
    ? t.runs
    : [{ text: t.text, ...PLAIN, size: t.fontSize, color: [0, 0, 0] as [number, number, number] }]
  const maxW = t.w * scale * 1.08 // small tolerance: the standard fonts are a little wider than Helvetica Neue
  const lines: Word[][] = [[]]
  let lineW = 0
  for (const run of runs) {
    const size = run.size * scale
    for (const piece of run.text.replace(/\t/g, ' ').split(/(\n| +)/)) {
      if (!piece) continue
      if (piece === '\n') {
        lines.push([])
        lineW = 0
        continue
      }
      const space = piece.trim() === ''
      const line = lines[lines.length - 1]
      if (space && line.length === 0) continue
      const width = await fonts.width(piece, run, size)
      if (!space && line.some((w) => !w.space) && lineW + width > maxW) {
        while (line.length && line[line.length - 1].space) line.pop()
        lines.push([])
        lineW = 0
      }
      lines[lines.length - 1].push({ text: piece, style: run, size, color: run.color, width, space })
      lineW += width
    }
  }

  let lineTop = top - t.y * scale
  let lastSize = (runs[0]?.size ?? 24) * scale
  for (const line of lines) {
    const size = line.length ? Math.max(...line.map((w) => w.size)) : lastSize
    lastSize = size
    const baseline = lineTop - size * 1.05
    let cx = x + t.x * scale
    for (const w of line) {
      for (const seg of await fonts.segments(w.text, w.style)) {
        page.drawText(seg.text, { x: cx, y: baseline, size: w.size, font: seg.font, color: rgb(...w.color) })
        cx += seg.font.widthOfTextAtSize(seg.text, w.size)
      }
    }
    lineTop -= size * 1.2
  }
}

type Item =
  | { z: number; kind: 'stroke'; v: Stroke }
  | { z: number; kind: 'fill'; v: FilledInk }
  | { z: number; kind: 'image'; v: CanvasImage }

/**
 * Draws images, ink strokes and filled ink of a canvas in their original order (Goodnotes layers
 * later elements on top) as one raw PDF content stream. Writing operators directly is much faster
 * than pdf-lib's per-shape drawing. Coordinates are whole tenths of a point in a flipped
 * coordinate system with y pointing down from the card's top-left corner.
 */
async function drawInk(page: PDFPage, side: Extract<Side, { kind: 'canvas' }>, x: number, top: number, scale: number, embed: Embed) {
  const items: Item[] = [
    ...side.images.map((v) => ({ z: v.z ?? 0, kind: 'image' as const, v })),
    ...side.strokes.map((v) => ({ z: v.z ?? 0, kind: 'stroke' as const, v })),
    ...side.fills.map((v) => ({ z: v.z ?? 0, kind: 'fill' as const, v })),
  ].sort((a, b) => a.z - b.z)
  if (items.length === 0) return

  const f = (v: number) => (Math.round(v * 1000) / 1000).toString()
  const t = (v: number) => Math.round(v * 10)
  const alpha = (a: number) => {
    if (a >= 1) return ''
    const gs = page.node.newExtGState('GS', page.doc.context.obj({ CA: a, ca: a }))
    return `${gs.asString()} gs `
  }
  const ops: string[] = [`q ${f(scale / 10)} 0 0 ${f(-scale / 10)} ${f(x)} ${f(top)} cm 1 J 1 j`]

  for (const item of items) {
    if (item.kind === 'image') {
      const img = item.v
      const pimg = await embed(img.data)
      if (!pimg) continue
      const name = page.node.newXObject('Image', pimg.ref)
      // unit square → image rectangle, flipped back so the picture is upright
      ops.push(`q ${f(img.w * 10)} 0 0 ${f(-img.h * 10)} ${f(img.x * 10)} ${f((img.y + img.h) * 10)} cm ${name.asString()} Do Q`)
    } else if (item.kind === 'stroke') {
      const s = item.v
      const [r, g, b, a] = s.color
      ops.push(`q ${alpha(a)}${f(r)} ${f(g)} ${f(b)} RG ${t(Math.max(s.width, 0.5))} w`)
      let cx = s.start[0]
      let cy = s.start[1]
      ops.push(`${t(cx)} ${t(cy)} m`)
      if (s.segments.length === 0) ops.push(`${t(cx) + 1} ${t(cy)} l`)
      const seg = s.segments
      for (let k = 0; k < seg.length; k += 4) {
        const qx = seg[k]
        const qy = seg[k + 1]
        const ex = seg[k + 2]
        const ey = seg[k + 3]
        // quadratic → cubic Bézier
        ops.push(
          `${t(cx + (2 / 3) * (qx - cx))} ${t(cy + (2 / 3) * (qy - cy))} ${t(ex + (2 / 3) * (qx - ex))} ${t(ey + (2 / 3) * (qy - ey))} ${t(ex)} ${t(ey)} c`,
        )
        cx = ex
        cy = ey
      }
      ops.push('S Q')
    } else {
      const ink = item.v
      const [r, g, b, a] = ink.color
      ops.push(`q ${alpha(a)}${f(r)} ${f(g)} ${f(b)} rg`)
      for (const sp of ink.subpaths) {
        ops.push(`${t(sp.start[0])} ${t(sp.start[1])} m`)
        const c = sp.curves
        for (let k = 0; k + 5 < c.length; k += 6)
          ops.push(`${t(c[k])} ${t(c[k + 1])} ${t(c[k + 2])} ${t(c[k + 3])} ${t(c[k + 4])} ${t(c[k + 5])} c`)
        ops.push('h')
      }
      ops.push('f Q')
    }
  }
  ops.push('Q')
  await addRawContent(page, ops)
}

async function addRawContent(page: PDFPage, ops: string[]) {
  const ctx = page.doc.context
  const raw = new TextEncoder().encode(ops.join('\n'))
  const deflated = await nativeDeflate(raw)
  const stream = deflated ? ctx.stream(deflated, { Filter: 'FlateDecode' }) : ctx.flateStream(raw)
  page.node.addContentStream(ctx.register(stream))
}

/** zlib-compresses with the browser's built-in CompressionStream when available (much faster than JS). */
async function nativeDeflate(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null
  try {
    const out = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'))
    return new Uint8Array(await new Response(out).arrayBuffer())
  } catch {
    return null
  }
}

async function drawCentredText(page: PDFPage, fonts: FontBook, text: string, cx: number, cy: number, maxW: number, size: number) {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w
    if (cur && (await fonts.width(t, PLAIN, size)) > maxW) {
      lines.push(cur)
      cur = w
    } else cur = t
  }
  if (cur) lines.push(cur)
  const lh = size * 1.2
  const y0 = cy + ((lines.length - 1) * lh) / 2 - size * 0.35
  for (const [k, l] of lines.entries()) {
    let lx = cx - (await fonts.width(l, PLAIN, size)) / 2
    for (const seg of await fonts.segments(l, PLAIN)) {
      page.drawText(seg.text, { x: lx, y: y0 - k * lh, size, font: seg.font, color: rgb(0, 0, 0) })
      lx += seg.font.widthOfTextAtSize(seg.text, size)
    }
  }
}

async function embedImage(pdf: PDFDocument, data: Uint8Array): Promise<PDFImage | null> {
  try {
    if (data[0] === 0x89 && data[1] === 0x50) return await pdf.embedPng(data)
    if (data[0] === 0xff && data[1] === 0xd8) return await pdf.embedJpg(data)
  } catch {
    // unsupported image variant; skip it
  }
  return null
}
