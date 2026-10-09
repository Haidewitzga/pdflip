import { LineCapStyle, PDFDocument, PDFFont, PDFImage, PDFPage, rgb, StandardFonts } from 'pdf-lib'
import { CARD_H, CARD_W, type Deck, type Side } from './goodnotes/model'

export type PdfLayout = 'pages' | 'stacked'

export interface PdfOptions {
  /** 'pages': question page then answer page. 'stacked': question above answer on one page. */
  layout: PdfLayout
  /** Prints "Deck · Card n of m · Question" in a band above each card. */
  labels: boolean
}

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
    if (!images.has(data)) images.set(data, await embedImage(pdf, data))
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

  for (const s of side.strokes) {
    const f = (n: number) => n.toFixed(2)
    let d = `M ${f(s.start[0])} ${f(s.start[1])}`
    for (let k = 0; k < s.segments.length; k += 4) {
      const [qx, qy, ex, ey] = s.segments.slice(k, k + 4)
      d += ` Q ${f(qx)} ${f(qy)} ${f(ex)} ${f(ey)}`
    }
    if (s.segments.length === 0) d += ` L ${f(s.start[0] + 0.01)} ${f(s.start[1])}`
    page.drawSvgPath(d, {
      x,
      y: top,
      scale,
      borderColor: rgb(s.color[0], s.color[1], s.color[2]),
      borderOpacity: s.color[3],
      borderWidth: Math.max(s.width, 0.8) * 1.4 * scale,
      borderLineCap: LineCapStyle.Round,
    })
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
