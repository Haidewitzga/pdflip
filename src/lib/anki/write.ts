import JSZip from 'jszip'
import type { Database, SqlJsStatic } from 'sql.js'

/** One Anki card: a picture for the question and one for the answer. */
export interface ImageCard {
  /** JPEG or PNG bytes. */
  front: Uint8Array
  back: Uint8Array
}

export interface NewAnkiDeck {
  title: string
  cards: ImageCard[]
}

// The classic package layout (collection.anki2, schema 11): every Anki app can import it,
// including AnkiMobile, AnkiDroid and current desktop versions.
const SCHEMA = `
CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null,
  ver integer not null, dty integer not null, usn integer not null, ls integer not null, conf text not null,
  models text not null, decks text not null, dconf text not null, tags text not null);
CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null,
  usn integer not null, tags text not null, flds text not null, sfld integer not null, csum integer not null,
  flags integer not null, data text not null);
CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null,
  mod integer not null, usn integer not null, type integer not null, queue integer not null, due integer not null,
  ivl integer not null, factor integer not null, reps integer not null, lapses integer not null, left integer not null,
  odue integer not null, odid integer not null, flags integer not null, data text not null);
CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null,
  ivl integer not null, lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
CREATE INDEX ix_notes_usn on notes (usn);
CREATE INDEX ix_cards_usn on cards (usn);
CREATE INDEX ix_revlog_usn on revlog (usn);
CREATE INDEX ix_cards_nid on cards (nid);
CREATE INDEX ix_cards_sched on cards (did, queue, due);
CREATE INDEX ix_revlog_cid on revlog (cid);
CREATE INDEX ix_notes_csum on notes (csum);
`

const CSS = `.card {
  font-family: arial;
  font-size: 20px;
  text-align: center;
  color: black;
  background-color: white;
}
img {
  max-width: 100%;
  max-height: 90vh;
  height: auto;
}`

/** Anki's default deck options (needed by older importers). */
const DEFAULT_DECK_CONF = {
  id: 1,
  name: 'Default',
  mod: 0,
  usn: 0,
  maxTaken: 60,
  autoplay: true,
  timer: 0,
  replayq: true,
  dyn: false,
  new: { bury: true, delays: [1, 10], initialFactor: 2500, ints: [1, 4, 7], order: 1, perDay: 20, separate: true },
  rev: { bury: true, ease4: 1.3, fuzz: 0.05, ivlFct: 1, maxIvl: 36500, minSpace: 1, perDay: 200 },
  lapse: { delays: [10], leechAction: 0, leechFails: 8, minInt: 1, mult: 0 },
}

const deckJson = (id: number, name: string, mod: number) => ({
  id,
  name,
  mod,
  usn: -1,
  desc: '',
  dyn: 0,
  conf: 1,
  collapsed: false,
  browserCollapsed: false,
  extendNew: 0,
  extendRev: 0,
  newToday: [0, 0],
  revToday: [0, 0],
  lrnToday: [0, 0],
  timeToday: [0, 0],
})

const GUID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

function guid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10))
  return Array.from(bytes, (b) => GUID_CHARS[b % GUID_CHARS.length]).join('')
}

/** First 8 hex digits of the SHA-1 of a note's first field, as Anki uses for duplicate checks. */
async function checksum(text: string): Promise<number> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text)))
  return ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0
}

const extension = (data: Uint8Array) => (data[0] === 0x89 && data[1] === 0x50 ? 'png' : 'jpg')

/**
 * Creates an Anki package (.apkg) with one "front picture / back picture" note per card.
 * `SQL` is an initialised sql.js module (see loadSqlJs in the browser).
 */
export async function writeApkg(deck: NewAnkiDeck, SQL: SqlJsStatic): Promise<Uint8Array> {
  const now = Date.now()
  const sec = Math.floor(now / 1000)
  // Anki ids are millisecond timestamps; consecutive values keep them unique within the package.
  const deckId = now
  const modelId = now + 1
  let nextId = now + 2
  const title = deck.title.trim() || 'Flashcards'

  const model = {
    id: modelId,
    name: 'PDFlip picture card',
    type: 0,
    mod: sec,
    usn: -1,
    sortf: 0,
    did: deckId,
    tmpls: [{ name: 'Card 1', ord: 0, qfmt: '{{Front}}', afmt: '{{Back}}', bqfmt: '', bafmt: '', did: null }],
    flds: ['Front', 'Back'].map((name, ord) => ({ name, ord, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] })),
    css: CSS,
    latexPre:
      '\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n',
    latexPost: '\\end{document}',
    latexsvg: false,
    req: [[0, 'any', [0]]],
    tags: [],
    vers: [],
  }
  const conf = {
    activeDecks: [deckId],
    curDeck: deckId,
    newSpread: 0,
    collapseTime: 1200,
    timeLim: 0,
    estTimes: true,
    dueCounts: true,
    curModel: modelId,
    nextPos: deck.cards.length + 1,
    sortType: 'noteFld',
    sortBackwards: false,
    addToCur: true,
  }

  const db: Database = new SQL.Database()
  try {
    db.run(SCHEMA)
    db.run('INSERT INTO col VALUES (1, ?, ?, ?, 11, 0, 0, 0, ?, ?, ?, ?, ?)', [
      sec,
      now,
      now,
      JSON.stringify(conf),
      JSON.stringify({ [modelId]: model }),
      JSON.stringify({ 1: deckJson(1, 'Default', sec), [deckId]: deckJson(deckId, title, sec) }),
      JSON.stringify({ 1: DEFAULT_DECK_CONF }),
      '{}',
    ])

    // Media files are stored as "0", "1", ... and named in the "media" map. The names start with
    // the deck id so they cannot clash with pictures already in the user's collection.
    const media: Record<string, string> = {}
    const files: Uint8Array[] = []
    const addMedia = (data: Uint8Array, name: string) => {
      const file = `pdflip-${deckId}-${name}.${extension(data)}`
      media[String(files.length)] = file
      files.push(data)
      return file
    }

    for (const [i, card] of deck.cards.entries()) {
      const n = String(i + 1).padStart(4, '0')
      const front = `<img src="${addMedia(card.front, `${n}-q`)}">`
      const back = `<img src="${addMedia(card.back, `${n}-a`)}">`
      const noteId = nextId++
      const cardId = nextId++
      db.run('INSERT INTO notes VALUES (?, ?, ?, ?, -1, ?, ?, ?, ?, 0, ?)', [
        noteId,
        guid(),
        modelId,
        sec,
        '',
        `${front}\x1f${back}`,
        front,
        await checksum(front),
        '',
      ])
      // new card, shown in deck order
      db.run('INSERT INTO cards VALUES (?, ?, ?, 0, ?, -1, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, ?)', [cardId, noteId, deckId, sec, i + 1, ''])
    }

    const zip = new JSZip()
    const opts = { compression: 'DEFLATE' as const }
    zip.file('collection.anki2', db.export(), opts)
    zip.file('media', JSON.stringify(media), opts)
    // pictures are already compressed
    files.forEach((data, k) => zip.file(String(k), data, { compression: 'STORE' }))
    return zip.generateAsync({ type: 'uint8array' })
  } finally {
    db.close()
  }
}
