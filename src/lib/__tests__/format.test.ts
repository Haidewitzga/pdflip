import { readFileSync, existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { Msg, readStream, View, writeStream } from '../pb'
import { decodeBv41 } from '../lz4'
import { uuidPlusOne } from '../uuid'
import { readDeck, rtfToText } from '../goodnotes/read'
import { fractionalKeys, writeDeck } from '../goodnotes/write'
import { deckToPdf } from '../deckToPdf'
import { autoMarks, pairMarks, splitPages } from '../pairing'

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
    expect(splitPages(2, 'top-bottom')[1].back.crop).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 })
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
