import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { PDFDocument, rgb } from 'pdf-lib'
import { CARD_H, CARD_W } from './goodnotes/model'
import { writeDeck, type NewCard, type SideImage } from './goodnotes/write'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/** Warnings from pdf.js for the PDF opened most recently (see pdfWorker.ts). */
let collecting: Set<string> | null = null
let workerStarted = false

/** Starts pdf.js's worker through our wrapper, which forwards its warnings. */
function startWorker() {
  if (workerStarted || typeof Worker === 'undefined') return
  workerStarted = true
  try {
    const worker = new Worker(new URL('./pdfWorker.ts', import.meta.url), { type: 'module' })
    worker.addEventListener('message', (e: MessageEvent) => {
      const w = (e.data as { pdflipWarning?: unknown } | null)?.pdflipWarning
      if (typeof w === 'string') collecting?.add(w)
    })
    pdfjs.GlobalWorkerOptions.workerPort = worker
  } catch {
    // pdf.js then starts its own worker from workerSrc, without forwarded warnings
  }
}

export type PdfDoc = pdfjs.PDFDocumentProxy

/** Page sizes in points (rotation applied). */
export async function pageSizes(doc: PdfDoc): Promise<{ w: number; h: number }[]> {
  const out: { w: number; h: number }[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const vp = (await doc.getPage(p)).getViewport({ scale: 1 })
    out.push({ w: vp.width, h: vp.height })
  }
  return out
}

/** pdf.js version, for problem reports. */
export const PDFJS_VERSION = pdfjs.version

/**
 * Character maps (CMaps) a PDF asked for while it was drawn but that could not be loaded. PDFs with
 * fonts that are not embedded in the file, typically Chinese, Japanese or Korean text, need them;
 * without one that text is missing from the rendered pages. Filled while pages are rendered.
 */
const missingCMaps = new WeakMap<PdfDoc, Set<string>>()
const warningsOf = new WeakMap<PdfDoc, Set<string>>()

export function missingCharacterMaps(doc: PdfDoc): string[] {
  return [...(missingCMaps.get(doc) ?? [])].sort()
}

/** Warnings pdf.js gave while reading and drawing this PDF (filled while pages are rendered). */
export function readerWarnings(doc: PdfDoc): string[] {
  return [...(warningsOf.get(doc) ?? [])]
}

/**
 * pdf.js's character maps, copied to cmaps/ by the build (vite.config.ts). They are not part of the
 * offline copy, about 1.7 MB in all: a PDF loads the few it needs, and the service worker keeps those.
 */
const CMAP_URL = `${import.meta.env.BASE_URL}cmaps/`

async function fetchCMap(name: string): Promise<Uint8Array> {
  const res = await fetch(`${CMAP_URL}${encodeURIComponent(name)}.bcmap`)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}

/** Thrown for PDFs that cannot be opened; `technical` carries pdf.js's own message for reports. */
export class PdfOpenError extends Error {
  constructor(
    message: string,
    readonly technical?: string,
  ) {
    super(message)
  }
}

export async function openPdf(data: ArrayBuffer): Promise<PdfDoc> {
  startWorker()
  const missing = new Set<string>()
  const warnings = new Set<string>()
  collecting = warnings
  // pdf.js asks this factory (on the page, not in its worker) for every character map it needs.
  class RecordingCMapReader {
    async fetch({ name }: { name: string }): Promise<{ cMapData: Uint8Array; isCompressed: boolean }> {
      try {
        return { cMapData: await fetchCMap(name), isCompressed: true }
      } catch {
        // unknown name or offline: the text drawn with it goes missing, and the user can report it
        missing.add(name)
        throw new Error('Ensure that the `cMapUrl` and `cMapPacked` API parameters are provided.')
      }
    }
  }
  try {
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(data),
      isEvalSupported: false,
      enableXfa: false,
      CMapReaderFactory: RecordingCMapReader,
      useWorkerFetch: false,
    }).promise
    missingCMaps.set(doc, missing)
    warningsOf.set(doc, warnings)
    return doc
  } catch (e) {
    if (e instanceof Error && e.name === 'PasswordException') throw new Error('This PDF is password-protected. Remove the password and try again.')
    throw new PdfOpenError('Could not read this PDF.', e instanceof Error ? `${e.name}: ${e.message}` : String(e))
  }
}

/** Renders a page into a canvas whose longest side is at most maxPx. */
export async function renderPage(doc: PdfDoc, pageNo: number, maxPx: number): Promise<HTMLCanvasElement> {
  const base = (await doc.getPage(pageNo)).getViewport({ scale: 1 })
  return renderPageAtScale(doc, pageNo, maxPx / Math.max(base.width, base.height))
}

/** Renders a page at a given scale (pixels per PDF point). */
async function renderPageAtScale(doc: PdfDoc, pageNo: number, scale: number): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(pageNo)
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

export interface SideSpec {
  page: number
  crop?: Crop
  /** Exact place on the card (points); by default the image is scaled to fit with a margin. */
  target?: { x: number; y: number; w: number; h: number }
}

export interface CardSpec {
  front: SideSpec
  back: SideSpec
}

const MARGIN = 36
/** Image pixels per point of card: 2 matches the iPad's Retina display, so card text looks as sharp as the original. */
const PX_PER_CARD_POINT = 2
/** iPad Safari refuses canvases above ~16.7 megapixels; stay well below. */
const MAX_CANVAS_AREA = 12_000_000
const JPEG_QUALITY = 0.92

/**
 * Pixels per PDF point to render a page at, so the cropped region ends up with
 * PX_PER_CARD_POINT pixels per point of its width on the card.
 */
export function renderScale(page: { w: number; h: number }, crop: Crop | undefined, placedWidth: number): number {
  const cropW = (crop?.w ?? 1) * page.w
  let scale = (placedWidth * PX_PER_CARD_POINT) / cropW
  const area = page.w * scale * page.h * scale
  if (area > MAX_CANVAS_AREA) scale *= Math.sqrt(MAX_CANVAS_AREA / area)
  return scale
}

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
export function fit(w: number, h: number): Omit<SideImage, 'data'> {
  const s = Math.min((CARD_W - 2 * MARGIN) / w, (CARD_H - 2 * MARGIN) / h)
  const iw = w * s
  const ih = h * s
  return { x: (CARD_W - iw) / 2, y: (CARD_H - ih) / 2, w: iw, h: ih }
}

async function sideImage(doc: PdfDoc, spec: SideSpec, cache: Map<string, HTMLCanvasElement>) {
  const base = (await doc.getPage(spec.page)).getViewport({ scale: 1 })
  const page = { w: base.width, h: base.height }
  const crop = spec.crop
  // where the region goes on the card decides how finely the page is rendered
  const placed = spec.target ?? fit((crop?.w ?? 1) * page.w, (crop?.h ?? 1) * page.h)
  const scale = renderScale(page, crop, placed.w)
  const key = `${spec.page}@${scale.toFixed(4)}`
  let full = cache.get(key)
  if (!full) {
    full = await renderPageAtScale(doc, spec.page, scale)
    cache.set(key, full)
  }
  const c = cropCanvas(full, crop)
  return { canvas: c, image: { data: await toBytes(c, 'image/jpeg', JPEG_QUALITY), ...placed } }
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
  const cache = new Map<string, HTMLCanvasElement>()
  const cards: NewCard[] = []
  let thumb: Uint8Array | null = null
  for (const [i, spec] of specs.entries()) {
    const front = await sideImage(doc, spec.front, cache)
    const back = await sideImage(doc, spec.back, cache)
    if (!thumb) thumb = await thumbnail(front.canvas)
    cards.push({ front: front.image, back: back.image })
    // Keep memory bounded on long documents: only the most recent pages stay rendered.
    while (cache.size > 2) cache.delete(cache.keys().next().value!)
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
