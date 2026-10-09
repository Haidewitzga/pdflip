import JSZip from 'jszip'
import { Msg, writeStream } from '../pb'
import { canvasUuid, randomU32, randomU63, uuid4, uuidPlusOne } from '../uuid'
import { CARD_H, CARD_W } from './model'

/** An image placed on one side of a card, in card coordinates (points). */
export interface SideImage {
  /** PNG or JPEG bytes. */
  data: Uint8Array
  x: number
  y: number
  w: number
  h: number
}

export interface NewCard {
  front: SideImage
  back: SideImage
}

export interface NewDeck {
  title: string
  cards: NewCard[]
  /** Blank background PDF for the card template. */
  templatePdf: Uint8Array
  /** JPEG shown as the deck cover in the Goodnotes library. */
  thumbnail: Uint8Array
  locale?: string
}

/** Schema version found in Goodnotes 5.x exports this was verified against. */
const SCHEMA = 24
/** Goodnotes' built-in "blank white 16:10 landscape" card template. */
const CARD_TEMPLATE_ID = '4ECCCA78-3984-526E-8B2D-E2498B3611A9'
const TEXT_PLAIN = 'text/plain'

/**
 * Creates a .goodnotes flashcard deck whose card sides are images.
 *
 * The deck is an append-only event log (index.events.pb) plus one notes file
 * per card side and the attachment files. See docs/FORMAT.md.
 */
export async function writeDeck(deck: NewDeck): Promise<Uint8Array> {
  const docId = uuid4()
  const device = randomU63()
  const now = Date.now()
  // Goodnotes sequence numbers are millisecond timestamps that increase per event.
  let seq = BigInt(now)
  let noteSeq = 1000
  const clock = (counter = 1) => new Msg().int(1, counter).int(2, randomU32())

  const events: Msg[] = []
  const notes: [string, Uint8Array][] = []
  const attachments: [string, Uint8Array][] = []

  /** Wraps an event body with the bookkeeping fields every event carries. */
  const event = (kind: number, id: string, body: Msg) => events.push(new Msg().bytes(1, id).bytes(kind, body))
  const stamp = (m: Msg, seqField: number, deviceField: number) => {
    m.f64(10, now).bytes(11, uuid4())
    if (deviceField < seqField) m.int(deviceField, device).int(seqField, ++seq)
    else m.int(seqField, ++seq).int(deviceField, device)
    return m
  }
  const addAttachment = (data: Uint8Array) => {
    const id = uuid4()
    attachments.push([id, data])
    const body = new Msg().bytes(1, id).bytes(2, id).int(5, data.length).bytes(6, docId)
    body.f64(10, now).bytes(11, uuid4()).bytes(12, new Uint8Array()).int(14, device).int(15, ++seq).int(16, SCHEMA)
    event(6, id, body)
    return id
  }

  // Document
  {
    const body = new Msg()
      .bytes(1, docId)
      .bytes(2, new Msg().bytes(1, deck.title).bytes(2, clock()))
      .bytes(3, new Msg().bytes(1, uuid4()).bytes(2, clock()))
      .bytes(6, new Msg().bytes(1, 'P').bytes(2, clock()))
      .bytes(7, new Msg().bytes(1, uuid4()).bytes(2, clock()))
      .bytes(9, deck.locale ?? 'en_US')
    stamp(body, 14, 13)
      .int(15, 1)
      .bytes(17, new Uint8Array())
      .bytes(18, new Uint8Array())
      .bytes(19, new Msg().bytes(2, clock()))
      .int(20, SCHEMA)
    event(30, docId, body)
  }

  // Card template page with a blank PDF background
  const templateAtt = addAttachment(deck.templatePdf)
  const pageId = uuid4()
  {
    const body = new Msg()
      .bytes(1, docId)
      .bytes(2, pageId)
      .bytes(4, templateAtt)
      .int(5, 1)
      .int(6, 1)
      .bytes(8, new Msg().f32(1, CARD_W).f32(2, CARD_H))
      .bytes(9, CARD_TEMPLATE_ID)
      .f64(10, now)
      .bytes(11, uuid4())
      .bytes(12, new Msg().bytes(2, clock()))
      .bytes(13, new Msg().bytes(2, clock()))
      .int(15, device)
      .int(16, ++seq)
      .bytes(17, new Msg().bytes(2, clock()))
      .bytes(19, new Msg().bytes(2, clock()))
      .int(21, SCHEMA)
    event(2, pageId, body)
  }

  const orderKeys = fractionalKeys(deck.cards.length)
  let canvasIndex = 0

  /** Creates a canvas (one card side) holding a single image; returns its id. */
  const addCanvas = (img: SideImage) => {
    const att = addAttachment(img.data)
    const canvasId = canvasUuid()
    const noteId = uuidPlusOne(canvasId)
    const background = new Msg().bytes(
      1,
      new Msg().bytes(
        2,
        new Msg()
          .bytes(1, new Msg().f32(1, 0.8666667).f32(2, 0.8666667).f32(3, 0.8666667).f32(4, 1))
          .bytes(2, new Msg().f32(1, 1).f32(2, 1).f32(3, 1).f32(4, 1)),
      ),
    )
    const canvas = new Msg()
      .bytes(1, docId)
      .bytes(2, canvasId)
      .bytes(3, new Msg().bytes(1, pageId).bytes(2, clock()))
      .bytes(4, new Msg().bytes(1, '4' + fractionalKeys(1, ++canvasIndex)[0]).bytes(2, clock()))
    stamp(canvas, 14, 13).int(15, SCHEMA).bytes(17, background.bytes(2, clock()))
    event(54, canvasId, canvas)

    const reg = new Msg().bytes(1, noteId)
    stamp(reg, 14, 13).int(15, SCHEMA).bytes(16, docId)
    event(102, noteId, reg)

    const elemId = uuid4()
    const elemClockRand = randomU32()
    const elemClock = () => new Msg().int(1, 1).int(2, elemClockRand)
    const header = new Msg()
      .bytes(1, elemId)
      .bytes(2, elemClock())
      .bytes(4, att)
      .int(8, device)
      .int(9, ++noteSeq)
      .int(14, 5381)
      .int(16, SCHEMA)
    const rect = (a: number, b: number) =>
      new Msg().bytes(1, new Msg().f32(1, a).f32(2, b)).bytes(2, new Msg().f32(1, img.w).f32(2, img.h))
    const element = new Msg()
      .bytes(1, elemId)
      .bytes(2, rect(img.x, img.y))
      .bytes(3, rect(img.x + img.w / 2, img.y + img.h / 2))
      .bytes(4, att)
      .bytes(5, new Msg().bytes(1, new Msg().int(2, randomU32())))
      .bytes(15, elemClock())
      .int(18, SCHEMA)
    notes.push([noteId, writeStream([header, new Msg().bytes(1, element)])])
    return canvasId
  }

  const side = (canvasId: string | null, counter: number) => {
    const content = canvasId
      ? new Msg().bytes(3, new Msg().bytes(1, canvasId))
      : new Msg().bytes(1, new Msg().bytes(1, TEXT_PLAIN))
    return new Msg().bytes(1, content).bytes(2, canvasId ? clock(counter) : new Uint8Array())
  }

  deck.cards.forEach((card, i) => {
    const cardId = uuid4()
    const orderClock = clock()
    const order = () => new Msg().bytes(1, orderKeys[i]).bytes(2, orderClock)
    const created = new Msg().bytes(1, cardId).bytes(2, docId).bytes(4, order()).bytes(5, side(null, 0)).bytes(6, side(null, 0))
    created.bytes(7, new Uint8Array())
    stamp(created, 14, 13).int(15, SCHEMA)
    event(151, cardId, created)

    const frontCanvas = addCanvas(card.front)
    const backCanvas = addCanvas(card.back)
    const update = new Msg()
      .bytes(1, cardId)
      .bytes(2, docId)
      .bytes(3, order())
      .bytes(4, side(frontCanvas, 2))
      .bytes(5, side(backCanvas, 2))
      .bytes(6, new Uint8Array())
    stamp(update, 14, 13).int(15, SCHEMA)
    event(152, cardId, update)
  })

  // Assemble the archive in the same file order Goodnotes uses.
  const zip = new JSZip()
  const opts = { compression: 'DEFLATE' as const, createFolders: false }
  zip.file('document.info.pb', new Msg().int(1, 1).encode(), opts)
  zip.file('index.search.pb', new Uint8Array(), opts)
  zip.file('index.notes.pb', writeStream(notes.map(([id]) => new Msg().bytes(1, id).bytes(2, 'notes/' + id))), opts)
  for (const [id, data] of notes) zip.file('notes/' + id, data, opts)
  zip.file('index.events.pb', writeStream(events), opts)
  zip.file('thumbnail.jpg', deck.thumbnail, opts)
  zip.file(
    'index.attachments.pb',
    writeStream(attachments.map(([id]) => new Msg().bytes(1, id).bytes(2, 'attachments/' + id))),
    opts,
  )
  for (const [id, data] of attachments) zip.file('attachments/' + id, data, opts)
  zip.file('schema.pb', new Msg().int(1, SCHEMA).encode(), opts)
  return zip.generateAsync({ type: 'uint8array' })
}

const KEY_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

/** n strictly increasing, fixed-length order keys (Goodnotes sorts cards by these strings). */
export function fractionalKeys(n: number, offset = 0): string[] {
  const base = KEY_CHARS.length
  const keys: string[] = []
  for (let i = 0; i < n; i++) {
    let v = (i + offset + 1) * 1000
    let s = ''
    for (let k = 0; k < 4; k++) {
      s = KEY_CHARS[v % base] + s
      v = Math.floor(v / base)
    }
    keys.push(s)
  }
  return keys
}
