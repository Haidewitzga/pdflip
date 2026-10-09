import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { PDFDocument, PDFHexString, PDFName } from 'pdf-lib'
import { fileURLToPath } from 'node:url'
import * as pdfjs from 'pdfjs-dist'
import { missingCharacterMaps, openPdf } from '../pdfToCards'

// in Node pdf.js runs its worker in-process and imports it from a file path
pdfjs.GlobalWorkerOptions.workerSrc = fileURLToPath(import.meta.resolve('pdfjs-dist/build/pdf.worker.min.mjs'))

/** A PDF with "光合作用" in a font that is not embedded, encoded with the given character map. */
async function pdfWithCMap(cmap: string): Promise<ArrayBuffer> {
  const pdf = await PDFDocument.create()
  const ctx = pdf.context
  const cidFont = ctx.obj({
    Type: 'Font',
    Subtype: 'CIDFontType0',
    BaseFont: 'STSong-Light',
    CIDSystemInfo: { Registry: PDFHexString.fromText('Adobe'), Ordering: PDFHexString.fromText('GB1'), Supplement: 2 },
    FontDescriptor: ctx.obj({ Type: 'FontDescriptor', FontName: 'STSong-Light', Flags: 6, FontBBox: [0, -200, 1000, 900], ItalicAngle: 0, Ascent: 880, Descent: -120, CapHeight: 880, StemV: 93 }),
    DW: 1000,
  })
  const font = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'STSong-Light', Encoding: cmap, DescendantFonts: [cidFont] }))
  const page = pdf.addPage([200, 100])
  page.node.setFontDictionary(PDFName.of('F1'), font)
  // UCS-2 code units of 光合作用
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream('BT /F1 20 Tf 20 50 Td <514954084F5C7528> Tj ET')))
  return (await pdf.save()).slice().buffer
}

/** Serves pdf.js's character maps the way the built site does (cmaps/<name>.bcmap). */
function serveCMaps(online = true) {
  vi.stubGlobal('fetch', async (url: string) => {
    if (!online) throw new TypeError('Failed to fetch')
    const name = decodeURIComponent(String(url).match(/cmaps\/([^/]+)\.bcmap$/)?.[1] ?? '')
    try {
      return new Response(readFileSync(`node_modules/pdfjs-dist/cmaps/${name}.bcmap`))
    } catch {
      return new Response(null, { status: 404 })
    }
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PDF character maps', () => {
  it('loads the character maps of fonts that are not embedded, so their text is kept', async () => {
    serveCMaps()
    const doc = await openPdf(await pdfWithCMap('UniGB-UCS2-H'))
    const text = await (await doc.getPage(1)).getTextContent()
    expect(text.items.map((i) => ('str' in i ? i.str : '')).join('')).toBe('光合作用')
    expect(missingCharacterMaps(doc)).toEqual([])
  })

  it('still reports character maps it cannot load (offline before one was ever needed)', async () => {
    serveCMaps(false)
    const doc = await openPdf(await pdfWithCMap('UniGB-UCS2-H'))
    await (await doc.getPage(1)).getTextContent()
    expect(missingCharacterMaps(doc)).toEqual(['UniGB-UCS2-H'])
  })
})
