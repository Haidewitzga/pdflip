import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { PDFDocument, rgb } from 'pdf-lib'
import { CARD_H, CARD_W } from './goodnotes/model'
import { writeDeck, type NewCard, type SideImage } from './goodnotes/write'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export type PdfDoc = pdfjs.PDFDocumentProxy

export async function openPdf(data: ArrayBuffer): Promise<PdfDoc> {
  try {
    return await pdfjs.getDocument({ data: new Uint8Array(data) }).promise
  } catch (e) {
    if (e instanceof Error && e.name === 'PasswordException') throw new Error('This PDF is password-protected. Remove the password and try again.')
    throw new Error('Could not read this PDF.')
  }
}

/** Renders a page into a canvas whose longest side is at most maxPx. */
export async function renderPage(doc: PdfDoc, pageNo: number, maxPx: number): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(pageNo)
  const base = page.getViewport({ scale: 1 })
  const scale = maxPx / Math.max(base.width, base.height)
  const vp = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(vp.width)
  canvas.height = Math.round(vp.height)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  await page.render({ canvasContext: ctx, viewport: vp }).promise
  page.cleanup()
  return canvas
}

/** Region of a page as fractions (0..1) of its width/height. */
export interface Crop {
  x: number
  y: number
  w: number
  h: number
}

export interface CardSpec {
  front: { page: number; crop?: Crop }
  back: { page: number; crop?: Crop }
}

const MARGIN = 36
const RENDER_PX = 1800

function toBytes(canvas: HTMLCanvasElement, type: 'image/png' | 'image/jpeg', quality?: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      async (b) => (b ? resolve(new Uint8Array(await b.arrayBuffer())) : reject(new Error('Image encoding failed'))),
      type,
      quality,
    ),
  )
}

function cropCanvas(src: HTMLCanvasElement, crop?: Crop): HTMLCanvasElement {
  if (!crop) return src
  const c = document.createElement('canvas')
  const sx = Math.round(crop.x * src.width)
  const sy = Math.round(crop.y * src.height)
  c.width = Math.max(1, Math.round(crop.w * src.width))
  c.height = Math.max(1, Math.round(crop.h * src.height))
  c.getContext('2d')!.drawImage(src, sx, sy, c.width, c.height, 0, 0, c.width, c.height)
  return c
}

/** Scales an image of w×h to fit the card (minus margins), centred. */
function fit(w: number, h: number): Omit<SideImage, 'data'> {
  const s = Math.min((CARD_W - 2 * MARGIN) / w, (CARD_H - 2 * MARGIN) / h)
  const iw = w * s
  const ih = h * s
  return { x: (CARD_W - iw) / 2, y: (CARD_H - ih) / 2, w: iw, h: ih }
}

async function sideImage(doc: PdfDoc, spec: { page: number; crop?: Crop }, cache: Map<number, HTMLCanvasElement>) {
  let full = cache.get(spec.page)
  if (!full) {
    full = await renderPage(doc, spec.page, RENDER_PX)
    cache.set(spec.page, full)
  }
  const c = cropCanvas(full, spec.crop)
  return { canvas: c, image: { data: await toBytes(c, 'image/png'), ...fit(c.width, c.height) } }
}

async function blankTemplatePdf(): Promise<Uint8Array> {
  // Same page size as Goodnotes' blank 16:10 card template.
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([650.88, 406.8])
  page.drawRectangle({ x: 0, y: 0, width: 650.88, height: 406.8, color: rgb(1, 1, 1) })
  return pdf.save()
}

async function thumbnail(first: HTMLCanvasElement): Promise<Uint8Array> {
  const c = document.createElement('canvas')
  c.width = 800
  c.height = 500
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, c.width, c.height)
  const f = fit(first.width, first.height)
  const k = c.width / CARD_W
  ctx.drawImage(first, f.x * k, f.y * k, f.w * k, f.h * k)
  return toBytes(c, 'image/jpeg', 0.85)
}

/** Builds a .goodnotes deck from marked PDF pages. */
export async function pdfToDeck(
  doc: PdfDoc,
  title: string,
  specs: CardSpec[],
  onProgress?: (done: number, total: number) => void,
): Promise<Uint8Array> {
  const cache = new Map<number, HTMLCanvasElement>()
  const cards: NewCard[] = []
  let thumb: Uint8Array | null = null
  for (const [i, spec] of specs.entries()) {
    const front = await sideImage(doc, spec.front, cache)
    const back = await sideImage(doc, spec.back, cache)
    if (!thumb) thumb = await thumbnail(front.canvas)
    cards.push({ front: front.image, back: back.image })
    // Keep memory bounded on long documents: only the most recent pages stay rendered.
    while (cache.size > 3) cache.delete(cache.keys().next().value!)
    onProgress?.(i + 1, specs.length)
  }
  return writeDeck({
    title,
    cards,
    templatePdf: await blankTemplatePdf(),
    thumbnail: thumb ?? new Uint8Array(),
    locale: navigator.language.replace('-', '_'),
  })
}
