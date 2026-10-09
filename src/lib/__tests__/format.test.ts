import { readFileSync, existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { Msg, readStream, View, writeStream } from '../pb'
import { decodeBv41 } from '../lz4'
import { parseRtf, classifyFont } from '../rtf'
import { uuidPlusOne } from '../uuid'
import { readDeck, rtfToText } from '../goodnotes/read'
import { fractionalKeys, writeDeck } from '../goodnotes/write'
import { deckToPdf } from '../deckToPdf'
import { autoMarks, pairMarks, restorePdflipCards, splitPages } from '../pairing'
import { detectPdflipLayout, pdflipRegions } from '../pdflipLayout'
import { PDFDocument, PDFName } from 'pdf-lib'

// 1×1 transparent PNG
const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='),
  (c) => c.charCodeAt(0),
)

describe('protobuf', () => {
  it('round-trips fields and streams, including 64-bit varints', () => {
    const m = new Msg().bytes(1, 'hello').int(2, 8418732036602291469n).f32(3, 1.5).f64(4, 2.25).bytes(5, new Msg().int(1, 7))
    const [back] = readStream(writeStream([m]))
    const v = new View(back)
    expect(v.str(1)).toBe('hello')
    expect(v.int(2)).toBe(8418732036602291469n)
    expect(v.num(3)).toBe(1.5)
    expect(v.num(4)).toBe(2.25)
    expect(v.msg(5)?.int(1)).toBe(7n)
  })
})

describe('bv41', () => {
  it('decodes literal and match sequences', () => {
    // "abcabcabcabc": 3 literals then a match (offset 3, length 9)
    const block = Uint8Array.from([0x35, 0x61, 0x62, 0x63, 0x03, 0x00])
    const head = new Uint8Array(12)
    head.set([0x62, 0x76, 0x34, 0x31])
    new DataView(head.buffer).setUint32(4, 12, true)
    new DataView(head.buffer).setUint32(8, block.length, true)
    const blob = Uint8Array.from([...head, ...block, 0x62, 0x76, 0x34, 0x24])
    expect(new TextDecoder().decode(decodeBv41(blob))).toBe('abcabcabcabc')
  })
})

describe('helpers', () => {
  it('derives note ids by adding one to the canvas id', () => {
    expect(uuidPlusOne('9BC52094-6D5D-5DF5-98B5-85411259872F')).toBe('9BC52094-6D5D-5DF5-98B5-854112598730')
  })
  it('creates increasing order keys', () => {
    const k = fractionalKeys(500)
    expect([...k].sort()).toEqual(k)
    expect(new Set(k).size).toBe(500)
  })
  it('extracts text from Goodnotes RTF', () => {
    const rtf =
      '{\\rtf1\\ansi\\ansicpg1252\\cocoartf2867\n{\\fonttbl\\f0\\fnil\\fcharset0 HelveticaNeue;}\n{\\colortbl;\\red255\\green255\\blue255;\\red0\\green0\\blue0;}\n\\pard\\tx560\\partightenfactor0\n\n\\f0\\fs48 \\cf2 Gr\\\'fc\\uc0\\u223 e}'
    expect(rtfToText(rtf)).toBe('Grüße')
  })
})

describe('pairing', () => {
  it('alternates pages and skips', () => {
    const { cards, unpaired } = pairMarks(autoMarks(5, new Set([1])))
    expect(cards.map((c) => [c.front.page, c.back.page])).toEqual([[2, 3], [4, 5]])
    expect(unpaired).toEqual([])
  })
  it('reports pages without a partner', () => {
    expect(pairMarks(['Q', 'Q', 'A', 'A']).unpaired).toEqual([1, 4])
  })
  it('splits pages into halves', () => {
    expect(splitPages(2)[1].back.crop).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 })
  })
})

describe('deck writer', () => {
  it('writes a deck that the reader understands', async () => {
    const side = (x: number) => ({ data: PNG, x, y: 20, w: 300, h: 200 })
    const bytes = await writeDeck({
      title: 'Test deck',
      cards: [
        { front: side(10), back: side(20) },
        { front: side(30), back: side(40) },
      ],
      templatePdf: new Uint8Array([1]),
      thumbnail: new Uint8Array([2]),
    })
    const zip = await JSZip.loadAsync(bytes)
    expect(Object.keys(zip.files)).toContain('index.events.pb')
    expect(Object.keys(zip.files).filter((n) => n.startsWith('notes/'))).toHaveLength(4)

    const deck = await readDeck(bytes)
    expect(deck.title).toBe('Test deck')
    expect(deck.cards).toHaveLength(2)
    const front = deck.cards[1].front
    expect(front.kind).toBe('canvas')
    if (front.kind === 'canvas') {
      expect(front.images).toHaveLength(1)
      expect(front.images[0]).toMatchObject({ x: 30, y: 20, w: 300, h: 200 })
    }
    const pdf = await deckToPdf(deck, { layout: 'pages', labels: true })
    expect(new TextDecoder().decode(pdf.subarray(0, 5))).toBe('%PDF-')
  })
})

describe('deck reader', () => {
  it('reads picture card sides', async () => {
    const side = (content: Msg) => new Msg().bytes(1, content).bytes(2, new Msg().int(1, 1).int(2, 5))
    const card = new Msg()
      .bytes(1, 'CARD')
      .bytes(3, new Msg().bytes(1, 'A'))
      .bytes(4, side(new Msg().bytes(2, new Msg().bytes(1, 'image/png').bytes(2, 'PIC'))))
      .bytes(5, side(new Msg().bytes(1, new Msg().bytes(1, 'text/plain').bytes(2, 'Answer'))))
    const zip = new JSZip()
    zip.file('index.events.pb', writeStream([new Msg().bytes(1, 'CARD').bytes(152, card)]))
    zip.file('attachments/PIC', PNG)
    const deck = await readDeck(await zip.generateAsync({ type: 'uint8array' }))
    expect(deck.cards[0].front).toEqual({ kind: 'image', data: PNG })
    expect(deck.cards[0].back).toEqual({ kind: 'text', text: 'Answer' })
    const pdf = await deckToPdf(deck, { layout: 'pages', labels: false })
    expect(pdf.length).toBeGreaterThan(500)
  })
})

// Wraps bytes in a bv41 container using a single literal-only LZ4 block.
function bv41(data: Uint8Array): Uint8Array {
  const lit = data.length
  const token: number[] = []
  if (lit < 15) token.push(lit << 4)
  else {
    token.push(0xf0)
    let r = lit - 15
    while (r >= 255) {
      token.push(255)
      r -= 255
    }
    token.push(r)
  }
  const block = Uint8Array.from([...token, ...data])
  const head = new Uint8Array(12)
  head.set([0x62, 0x76, 0x34, 0x31])
  new DataView(head.buffer).setUint32(4, data.length, true)
  new DataView(head.buffer).setUint32(8, block.length, true)
  return Uint8Array.from([...head, ...block, 0x62, 0x76, 0x34, 0x24])
}

function tpl(signature: string, payload: number[]): Uint8Array {
  const sig = new TextEncoder().encode(signature)
  const out = new Uint8Array(8 + sig.length + 1 + payload.length)
  out.set([0x74, 0x70, 0x6c, 0])
  out.set(sig, 8)
  out.set(payload, 8 + sig.length + 1)
  return out
}

const u16 = (v: number) => [v & 255, v >> 8]
const u32 = (v: number) => [...new Uint8Array(new Uint32Array([v]).buffer)]
const f32 = (v: number) => [...new Uint8Array(new Float32Array([v]).buffer)]

async function deckWithStroke(stroke: Msg): Promise<Uint8Array> {
  const canvas = 'C0000000-0000-5000-8000-000000000010'
  const side = (content: Msg) => new Msg().bytes(1, content).bytes(2, new Msg().int(1, 1).int(2, 5))
  const card = new Msg()
    .bytes(1, 'CARD')
    .bytes(3, new Msg().bytes(1, 'A'))
    .bytes(4, side(new Msg().bytes(3, new Msg().bytes(1, canvas))))
    .bytes(5, side(new Msg().bytes(1, new Msg().bytes(1, 'text/plain').bytes(2, 'x'))))
  const zip = new JSZip()
  zip.file('index.events.pb', writeStream([new Msg().bytes(1, 'CARD').bytes(152, card)]))
  zip.file('notes/' + uuidPlusOne(canvas), writeStream([new Msg().bytes(7, stroke)]))
  return zip.generateAsync({ type: 'uint8array' })
}

describe('ink formats', () => {
  it('reads strokes snapped to a straight line', async () => {
    const empty = tpl('vuA(v)A(S(uu))A(S(uuuu))vA(f)', [...u16(2), ...f32(1.5), ...u32(0), ...u32(0), ...u32(0), ...u16(1), ...u32(0)])
    const point = (x: number, y: number) => new Msg().f32(1, x).f32(2, y)
    const shape = new Msg()
      .bytes(1, new Msg().bytes(1, point(10, 20)).bytes(1, point(110, 20)))
      .bytes(5, new Msg().int(2, 1))
      .f32(15, 2)
    const stroke = new Msg().bytes(1, 'S1').bytes(2, bv41(empty)).bytes(4, new Msg().f32(4, 1)).bytes(6, new Msg().f32(1, 5)).bytes(9, shape)
    const side = (await readDeck(await deckWithStroke(stroke))).cards[0].front
    expect(side.kind === 'canvas' && side.strokes[0]).toMatchObject({ start: [15, 20], segments: [65, 20, 115, 20], width: 2 })
  })

  it('reads ink stored as centre lines plus filled outlines', async () => {
    const arr16 = (xs: number[]) => [...u32(xs.length), ...xs.flatMap(u16)]
    const arr32 = (xs: number[]) => [...u32(xs.length), ...xs.flatMap(f32)]
    const payload = [
      ...u16(2), ...u32(0),
      ...arr16([0, 1, 2, 3]), ...arr32([10, 10, 0, 0, 1]), ...arr32([15, 10, 20, 10, 0, 0, 0, 0, 1, 1]), ...arr16([2]),
      ...arr16([2, 4]), ...arr32([1, 2]), ...arr32([]), ...arr32([3, 4, 5, 6, 7, 8]), ...arr32([]), ...arr16([]),
    ]
    const blob = bv41(tpl('vuA(v)A(u)A(u)A(v)A(v)A(u)A(u)A(u)A(u)A(v)', payload))
    const stroke = new Msg().bytes(1, 'S2').bytes(2, blob).bytes(4, new Msg().f32(1, 1).f32(4, 1))
    const side = (await readDeck(await deckWithStroke(stroke))).cards[0].front
    expect(side.kind === 'canvas' && side.fills[0]).toMatchObject({ color: [1, 0, 0, 1], subpaths: [{ start: [1, 2], curves: [3, 4, 5, 6, 7, 8] }] })
    expect(side.kind === 'canvas' && side.strokes[0]).toMatchObject({ start: [10, 10], segments: [15, 10, 20, 10] })
    const pdf = await deckToPdf({ title: 't', cards: [{ front: side, back: side }] }, { layout: 'pages', labels: false })
    expect(pdf.length).toBeGreaterThan(500)
  })
})

describe('layering', () => {
  it('orders canvas elements by their layer counter, not their file position', async () => {
    const canvas = 'C0000000-0000-5000-8000-000000000010'
    const layer = (n: number) => new Msg().bytes(1, new Msg().int(1, n).int(2, 9))
    const rect = (x: number) => new Msg().bytes(1, new Msg().f32(1, x).f32(2, 0)).bytes(2, new Msg().f32(1, 10).f32(2, 10))
    const empty = tpl('vuA(v)A(S(uu))A(S(uuuu))vA(f)', [...u16(2), ...f32(1.5), ...u32(0), ...u32(0), ...u32(0), ...u16(1), ...u32(0)])
    const shape = new Msg().bytes(1, new Msg().bytes(1, new Msg().f32(1, 0).f32(2, 0)).bytes(1, new Msg().f32(1, 5).f32(2, 5)))
    // file order: stroke (layer 50), image (layer 10)
    const stroke = new Msg().bytes(1, 'S').bytes(2, bv41(empty)).bytes(4, new Msg().f32(4, 1)).bytes(7, layer(50)).bytes(9, shape)
    const image = new Msg().bytes(1, 'I').bytes(2, rect(0)).bytes(4, 'PIC').bytes(5, layer(10))
    const side = (content: Msg) => new Msg().bytes(1, content).bytes(2, new Msg().int(1, 1).int(2, 5))
    const card = new Msg()
      .bytes(1, 'CARD')
      .bytes(3, new Msg().bytes(1, 'A'))
      .bytes(4, side(new Msg().bytes(3, new Msg().bytes(1, canvas))))
      .bytes(5, side(new Msg().bytes(1, new Msg().bytes(1, 'text/plain').bytes(2, 'x'))))
    const zip = new JSZip()
    zip.file('index.events.pb', writeStream([new Msg().bytes(1, 'CARD').bytes(152, card)]))
    zip.file('notes/' + uuidPlusOne(canvas), writeStream([new Msg().bytes(7, stroke), new Msg().bytes(1, image)]))
    zip.file('attachments/PIC', PNG)
    const front = (await readDeck(await zip.generateAsync({ type: 'uint8array' }))).cards[0].front
    if (front.kind !== 'canvas') throw new Error('expected canvas')
    expect(front.images[0].z!).toBeLessThan(front.strokes[0].z!)
  })
})

describe('PDFlip round trip', () => {
  it('recognises every PDFlip page layout from the exported page sizes', async () => {
    const side = { kind: 'text' as const, text: 'x' }
    const deck = { title: 't', cards: [{ front: side, back: side }] }
    for (const layout of ['pages', 'stacked'] as const) {
      for (const labels of [true, false]) {
        const pdf = await PDFDocument.load(await deckToPdf(deck, { layout, labels }))
        const sizes = pdf.getPages().map((p) => ({ w: p.getWidth(), h: p.getHeight() }))
        expect(detectPdflipLayout(sizes)).toEqual({ layout, labels })
      }
    }
    expect(detectPdflipLayout([{ w: 595, h: 842 }])).toBeNull()
  })

  it('maps each side to its card area at full size', () => {
    const stacked = { layout: 'stacked' as const, labels: true }
    const [card] = restorePdflipCards(splitPages(1), stacked)
    const [top, bottom] = pdflipRegions(stacked)
    expect(card.front).toEqual({ page: 1, ...top })
    expect(card.back).toEqual({ page: 1, ...bottom })
    expect(top.target.w).toBeGreaterThan(1170)
  })
})

describe('deleted cards and symbols', () => {
  const textSide = (t: string) => new Msg().bytes(1, new Msg().bytes(1, new Msg().bytes(1, 'text/plain').bytes(2, t))).bytes(2, new Msg().int(1, 1).int(2, 5))
  const card = (id: string, order: string, q: string) =>
    new Msg().bytes(1, id).bytes(152, new Msg().bytes(1, id).bytes(3, new Msg().bytes(1, order)).bytes(4, textSide(q)).bytes(5, textSide('a')))
  const del = (id: string, flag: number, counter: number) =>
    new Msg().bytes(1, id).bytes(153, new Msg().bytes(1, id).bytes(3, new Msg().int(1, flag).bytes(2, new Msg().int(1, counter).int(2, 1))))

  it('skips deleted cards and keeps restored ones', async () => {
    const zip = new JSZip()
    zip.file('index.events.pb', writeStream([card('A', 'a', 'kept'), card('B', 'b', 'deleted'), card('C', 'c', 'restored'), del('B', 1, 1), del('C', 1, 1), del('C', 0, 2)]))
    const deck = await readDeck(await zip.generateAsync({ type: 'uint8array' }))
    expect(deck.cards.map((c) => (c.front.kind === 'text' ? c.front.text : ''))).toEqual(['kept', 'restored'])
  })

  it('embeds a Unicode font only when the text needs one', async () => {
    let loads = 0
    const loadUnicodeFont = async () => {
      loads++
      return new Uint8Array(readFileSync('public/fonts/DejaVuSans.ttf'))
    }
    const deck = (t: string) => ({ title: 't', cards: [{ front: { kind: 'text' as const, text: t }, back: { kind: 'text' as const, text: 'x' } }] })
    await deckToPdf(deck('plain'), { layout: 'pages', labels: false, loadUnicodeFont })
    expect(loads).toBe(0)
    const pdf = await deckToPdf(deck('θ, Ω, ∑'), { layout: 'pages', labels: false, loadUnicodeFont })
    expect(loads).toBe(1)
    const loaded = await PDFDocument.load(pdf)
    const baseFonts = loaded.context
      .enumerateIndirectObjects()
      .map(([, obj]) => (obj as { get?: (k: unknown) => unknown }).get?.(PDFName.of('BaseFont'))?.toString() ?? '')
    expect(baseFonts.some((n) => n.includes('DejaVuSans'))).toBe(true)
  })
})

describe('text box formatting', () => {
  const rtf = [
    '{\\rtf1\\ansi\\ansicpg1252\\cocoartf2867',
    '\\cocoatextscaling1\\cocoaplatform1{\\fonttbl\\f0\\fnil\\fcharset0 HelveticaNeue;\\f1\\fnil\\fcharset0 HelveticaNeue-Bold;\\f2\\froman\\fcharset0 Times-Italic;}',
    '{\\colortbl;\\red255\\green255\\blue255;\\red0\\green0\\blue0;\\red255\\green0\\blue0;}',
    '{\\*\\expandedcolortbl;;\\cssrgb\\c0\\c0\\c0;\\cssrgb\\c100000\\c0\\c0;}',
    '\\pard\\tx560\\partightenfactor0',
    '',
    '\\f0\\fs48 \\cf2 Plain \\f1 bold\\f0  and \\cf3 red\\cf2 \\',
    '\\f2\\fs36 next \\i0\\b line \\uc0\\u952 }',
  ].join('\n')

  it('reads fonts, bold, italic, sizes, colours and line breaks', () => {
    const runs = parseRtf(rtf)
    expect(runs.map((r) => r.text).join('')).toBe('Plain bold and red\nnext line θ')
    const at = (t: string) => runs.find((r) => r.text.includes(t))!
    expect(at('Plain')).toMatchObject({ family: 'sans', bold: false, italic: false, size: 24, color: [0, 0, 0] })
    expect(at('bold')).toMatchObject({ family: 'sans', bold: true })
    expect(at('red')).toMatchObject({ color: [1, 0, 0] })
    expect(at('next')).toMatchObject({ family: 'serif', italic: true, size: 18 })
    expect(at('line')).toMatchObject({ family: 'serif', bold: true })
  })

  it('maps font names to families', () => {
    expect(classifyFont('Menlo-Regular').family).toBe('mono')
    expect(classifyFont('Georgia-BoldItalic')).toEqual({ family: 'serif', bold: true, italic: true })
    expect(classifyFont('Avenir-Book').family).toBe('sans')
  })

  it('draws styled text boxes', async () => {
    const runs = parseRtf(rtf)
    const side = { kind: 'canvas' as const, strokes: [], fills: [], images: [], texts: [{ x: 50, y: 50, w: 600, h: 200, text: 'x', fontSize: 24, runs }] }
    const pdf = await deckToPdf({ title: 't', cards: [{ front: side, back: side }] }, {
      layout: 'pages',
      labels: false,
      loadUnicodeFont: async () => new Uint8Array(readFileSync('public/fonts/DejaVuSans.ttf')),
    })
    const loaded = await PDFDocument.load(pdf)
    const baseFonts = loaded.context
      .enumerateIndirectObjects()
      .map(([, obj]) => (obj as { get?: (k: unknown) => unknown }).get?.(PDFName.of('BaseFont'))?.toString() ?? '')
    for (const f of ['/Helvetica', '/Helvetica-Bold', '/Times-Italic', '/Times-BoldItalic']) expect(baseFonts).toContain(f)
  })
})

// Optional check against a real Goodnotes export: GOODNOTES_SAMPLE=/path/to/deck.goodnotes npm test
const sample = process.env.GOODNOTES_SAMPLE
describe.skipIf(!sample || !existsSync(sample))('real Goodnotes deck', () => {
  it('reads cards, handwriting, images and text', async () => {
    const deck = await readDeck(readFileSync(sample!))
    const sides = deck.cards.flatMap((c) => [c.front, c.back])
    const strokes = sides.reduce((n, s) => n + (s.kind === 'canvas' ? s.strokes.length : 0), 0)
    console.log(`${deck.title}: ${deck.cards.length} cards, ${strokes} strokes`)
    expect(deck.cards.length).toBeGreaterThan(0)
    const pdf = await deckToPdf(deck, { layout: 'stacked', labels: true })
    expect(pdf.length).toBeGreaterThan(1000)
  })
})
