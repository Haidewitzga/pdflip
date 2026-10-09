import { PDFDocument, PDFFont, PDFImage, PDFPage, rgb, StandardFonts } from 'pdf-lib'
import { CARD_H, CARD_W, type Deck, type Side, type Stroke } from './goodnotes/model'

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
}

/** Lets the browser repaint (progress, spinners) between chunks of work. */
const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0))

const LABEL_BAND = 48
const GAP = 36

/** Renders a flashcard deck to a PDF. */
export async function deckToPdf(deck: Deck, opts: PdfOptions): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(deck.title)
  pdf.setCreator('PDFlip')
  const font = await pdf.embedFont(StandardFonts.Helvetica)
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
        if (opts.labels) drawLabel(page, font, label(what), CARD_H + band)
        await drawCard(page, font, side, 0, CARD_H, 1, embed)
      }
    } else {
      const h = band + CARD_H + GAP + band + CARD_H
      const page = pdf.addPage([CARD_W, h])
      let top = h
      for (const [side, what] of [[card.front, 'Question'], [card.back, 'Answer']] as const) {
        if (opts.labels) drawLabel(page, font, label(what), top)
        top -= band
        await drawCard(page, font, side, 0, top, 1, embed)
        top -= CARD_H + GAP
      }
    }
    opts.onProgress?.(i + 1, total)
    await yieldToUi()
  }
  return pdf.save()
}

function drawLabel(page: PDFPage, font: PDFFont, text: string, top: number) {
  page.drawText(safeText(font, text), { x: 24, y: top - 32, size: 16, font, color: rgb(0.45, 0.45, 0.5) })
}

type Embed = (data: Uint8Array) => Promise<PDFImage | null>

/** Draws one card side with its top-left corner at (x, top) in PDF coordinates. */
async function drawCard(page: PDFPage, font: PDFFont, side: Side, x: number, top: number, scale: number, embed: Embed) {
  const W = CARD_W * scale
  const H = CARD_H * scale
  page.drawRectangle({
    x: x + 6,
    y: top - H + 6,
    width: W - 12,
    height: H - 12,
    color: rgb(1, 1, 1),
    borderColor: rgb(0.85, 0.85, 0.88),
    borderWidth: 2,
  })

  if (side.kind === 'text') {
    drawCentredText(page, font, side.text, x + W / 2, top - H / 2, W - 160 * scale, 48 * scale)
    return
  }

  for (const img of side.images) {
    const pimg = await embed(img.data)
    if (pimg)
      page.drawImage(pimg, {
        x: x + img.x * scale,
        y: top - (img.y + img.h) * scale,
        width: img.w * scale,
        height: img.h * scale,
      })
  }

  for (const t of side.texts) {
    let size = t.fontSize * scale
    const lines = t.text.split('\n').map((l) => safeText(font, l))
    const widest = () => Math.max(0, ...lines.map((l) => font.widthOfTextAtSize(l, size)))
    while (size > 6 && widest() > t.w * scale * 1.05) size -= 1
    lines.forEach((line, k) => {
      page.drawText(line, { x: x + t.x * scale, y: top - t.y * scale - size * (k + 1) * 1.05, size, font, color: rgb(0, 0, 0) })
    })
  }

  await drawStrokes(page, side.strokes, x, top, scale)
}

/**
 * Writes all ink strokes of a card side as one raw PDF content stream, one path per pen
 * (colour + width). Much faster than drawing each stroke through pdf-lib's SVG path parser.
 * Coordinates are written as whole tenths of a point in a flipped coordinate system, which
 * keeps the stream small and cheap to build.
 */
async function drawStrokes(page: PDFPage, strokes: Stroke[], x: number, top: number, scale: number) {
  if (strokes.length === 0) return
  const groups = new Map<string, Stroke[]>()
  for (const s of strokes) {
    const key = `${s.color.map((c) => c.toFixed(3)).join(' ')}|${s.width.toFixed(2)}`
    const g = groups.get(key)
    if (g) g.push(s)
    else groups.set(key, [s])
  }
  const f = (v: number) => (Math.round(v * 1000) / 1000).toString()
  const t = (v: number) => Math.round(v * 10)
  // canvas units → tenths of a point, y pointing down from the card's top-left corner
  const ops: string[] = [`q ${f(scale / 10)} 0 0 ${f(-scale / 10)} ${f(x)} ${f(top)} cm 1 J 1 j`]
  for (const group of groups.values()) {
    const [r, g, b, a] = group[0].color
    ops.push('q')
    if (a < 1) {
      const gs = page.node.newExtGState('GS', page.doc.context.obj({ CA: a, ca: a }))
      ops.push(`${gs.asString()} gs`)
    }
    ops.push(`${f(r)} ${f(g)} ${f(b)} RG ${t(Math.max(group[0].width, 0.8) * 1.4)} w`)
    for (const s of group) {
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
    }
    ops.push('S Q')
  }
  ops.push('Q')
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

function drawCentredText(page: PDFPage, font: PDFFont, text: string, cx: number, cy: number, maxW: number, size: number) {
  const words = safeText(font, text).split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    const t = cur ? `${cur} ${w}` : w
    if (cur && font.widthOfTextAtSize(t, size) > maxW) {
      lines.push(cur)
      cur = w
    } else cur = t
  }
  if (cur) lines.push(cur)
  const lh = size * 1.2
  const y0 = cy + ((lines.length - 1) * lh) / 2 - size * 0.35
  lines.forEach((l, k) => {
    const w = font.widthOfTextAtSize(l, size)
    page.drawText(l, { x: cx - w / 2, y: y0 - k * lh, size, font, color: rgb(0, 0, 0) })
  })
}

/** Replaces characters the standard PDF font cannot encode. */
function safeText(font: PDFFont, s: string): string {
  let out = ''
  for (const ch of s) {
    try {
      font.encodeText(ch)
      out += ch
    } catch {
      out += '?'
    }
  }
  return out
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
