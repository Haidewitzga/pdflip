import { useEffect, useMemo, useRef, useState } from 'react'
import { openPdf, pageSizes, pdfToDeck, renderPage, type CardSpec, type PdfDoc } from '../lib/pdfToCards'
import { detectPdflipLayout, type PdflipLayout } from '../lib/pdflipLayout'
import { autoMarks, MODES, pairMarks, restorePdflipCards, splitPages, type Mark, type Mode } from '../lib/pairing'
import { canShareFiles, download, safeFilename, share } from '../lib/download'
import FilePicker from './FilePicker'
import Progress from './Progress'

const GOODNOTES_MIME = 'application/octet-stream'

export default function PdfToGoodnotes() {
  const [doc, setDoc] = useState<PdfDoc | null>(null)
  const [fileName, setFileName] = useState('')
  const [title, setTitle] = useState('')
  const [thumbs, setThumbs] = useState<(string | null)[]>([])
  const [mode, setMode] = useState<Mode>('alternate')
  const [skipped, setSkipped] = useState<Set<number>>(new Set())
  const [marks, setMarks] = useState<Mark[]>([])
  const [error, setError] = useState('')
  const [progress, setProgress] = useState<[number, number] | null>(null)
  const [result, setResult] = useState<Uint8Array | null>(null)
  const [thumbsDone, setThumbsDone] = useState(0)
  const [pdflip, setPdflip] = useState<PdflipLayout | null>(null)
  const [aspects, setAspects] = useState<number[]>([])
  const [restore, setRestore] = useState(true)
  const loadId = useRef(0)

  const pageCount = doc?.numPages ?? 0

  async function onFile(file: File) {
    setError('')
    setResult(null)
    const id = ++loadId.current
    try {
      const d = await openPdf(await file.arrayBuffer())
      if (id !== loadId.current) return
      const sizes = await pageSizes(d)
      const made = detectPdflipLayout(sizes)
      if (id !== loadId.current) return
      setAspects(sizes.map((s) => s.w / s.h))
      setPdflip(made)
      setRestore(true)
      setMode(made?.layout === 'stacked' ? 'top-bottom' : 'alternate')
      setDoc(d)
      setFileName(file.name)
      setTitle(file.name.replace(/\.pdf$/i, ''))
      setSkipped(new Set())
      setMarks(autoMarks(d.numPages))
      setThumbs(Array(d.numPages).fill(null))
      setThumbsDone(0)
      for (let p = 1; p <= d.numPages; p++) {
        if (id !== loadId.current) return
        const c = await renderPage(d, p, 280)
        const url = c.toDataURL('image/jpeg', 0.75)
        if (id !== loadId.current) return
        setThumbs((t) => {
          const n = t.slice()
          n[p - 1] = url
          return n
        })
        setThumbsDone(p)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  function clearFile() {
    loadId.current++
    setDoc(null)
    setFileName('')
    setTitle('')
    setThumbs([])
    setThumbsDone(0)
    setAspects([])
    setPdflip(null)
    setSkipped(new Set())
    setMarks([])
    setResult(null)
    setError('')
  }

  function chooseMode(m: Mode) {
    if (m === 'manual' && mode !== 'manual') setMarks(autoMarks(pageCount, skipped))
    setMode(m)
    setResult(null)
  }

  function tapPage(page: number) {
    setResult(null)
    if (mode === 'manual') {
      setMarks((ms) => {
        const n = ms.slice()
        n[page - 1] = n[page - 1] === 'Q' ? 'A' : n[page - 1] === 'A' ? 'skip' : 'Q'
        return n
      })
    } else {
      setSkipped((s) => {
        const n = new Set(s)
        if (n.has(page)) n.delete(page)
        else n.add(page)
        return n
      })
    }
  }

  const { cards, unpaired, labels, restoring } = useMemo(() => {
    const labels = new Map<number, string>()
    let cards: CardSpec[]
    let unpaired: number[] = []
    if (mode === 'top-bottom') {
      cards = splitPages(pageCount, skipped)
      cards.forEach((c, i) => labels.set(c.front.page, `Card ${i + 1}`))
    } else {
      const res = pairMarks(mode === 'manual' ? marks : autoMarks(pageCount, skipped))
      cards = res.cards
      unpaired = res.unpaired
      cards.forEach((c, i) => {
        labels.set(c.front.page, `Q${i + 1}`)
        labels.set(c.back.page, `A${i + 1}`)
      })
      unpaired.forEach((p) => labels.set(p, 'Unpaired'))
    }
    // PDFs made by PDFlip: put each card back at its original size.
    const restoring = !!pdflip && restore && (pdflip.layout === 'stacked' ? mode === 'top-bottom' : mode === 'alternate' || mode === 'manual')
    if (restoring) cards = restorePdflipCards(cards, pdflip!)
    return { cards, unpaired, labels, restoring }
  }, [mode, marks, skipped, pageCount, pdflip, restore])

  async function create() {
    if (!doc || cards.length === 0) return
    setError('')
    setResult(null)
    setProgress([0, cards.length])
    try {
      const bytes = await pdfToDeck(doc, title.trim() || 'Flashcards', cards, (d, t) => setProgress([d, t]))
      setResult(bytes)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setProgress(null)
    }
  }

  const outName = `${safeFilename(title || 'Flashcards')}.goodnotes`
  const isSplit = mode === 'top-bottom'
  useEffect(() => () => void doc?.destroy(), [doc])

  return (
    <section className="tool">
      <h1>Turn a PDF into Goodnotes flashcards</h1>
      <p className="lead">
        Pick a PDF, choose which pages are questions and answers, and download a flashcard deck you can open in Goodnotes
        and study with Smart Learn.
      </p>

      <fieldset className="settings" disabled={!!progress}>
        <FilePicker
          accept="application/pdf,.pdf"
          label={fileName ? 'Choose another PDF' : 'Choose a PDF'}
          onFile={onFile}
          hint="or drop a PDF here"
          fileName={fileName}
          onClear={clearFile}
        />
      </fieldset>

      {error && <p className="error" role="alert">{error}</p>}

      {doc && thumbsDone < pageCount && <Progress label="Loading pages…" done={thumbsDone} total={pageCount} />}

      {doc && (
        <>
          <fieldset className="settings" disabled={!!progress}>
          {pdflip && (
            <div className="notice">
              <p>
                <strong>This PDF was made with PDFlip.</strong>{' '}
                {restoring
                  ? 'Each card will be restored at its original size, without the card numbers and frame.'
                  : pdflip.layout === 'stacked'
                    ? 'Choose “Top / bottom” to restore each card at its original size.'
                    : 'Choose “Page pairs” or “Mark pages” to restore each card at its original size.'}
              </p>
              <label className="check">
                <input type="checkbox" checked={restore} onChange={(e) => { setRestore(e.target.checked); setResult(null) }} /> Restore
                PDFlip cards
              </label>
            </div>
          )}
          <h2>1. How are your questions and answers laid out?</h2>
          <div className="modes" role="radiogroup" aria-label="Layout">
            {MODES.map((m) => (
              <button key={m.id} role="radio" aria-checked={mode === m.id} className="mode" onClick={() => chooseMode(m.id)}>
                <strong>{m.label}</strong>
                <span>{m.hint}</span>
              </button>
            ))}
          </div>

          <h2>2. Check the pages</h2>
          <p className="muted">
            {mode === 'manual'
              ? 'Tap a page to cycle Question → Answer → Skip.'
              : 'Tap a page to skip it (for example a title page).'}{' '}
            {cards.length} card{cards.length === 1 ? '' : 's'}
            {unpaired.length > 0 && <span className="warn"> · {unpaired.length} page(s) without a partner will be left out</span>}
          </p>
          <ol className="pages">
            {thumbs.map((src, i) => {
              const page = i + 1
              const mark = mode === 'manual' ? marks[i] : skipped.has(page) ? 'skip' : undefined
              const label = labels.get(page)
              const state = mark === 'skip' ? 'skip' : label?.startsWith('Q') ? 'q' : label?.startsWith('A') ? 'a' : label === 'Unpaired' ? 'unpaired' : 'card'
              return (
                <li key={page}>
                  <button className={`page ${state}`} onClick={() => tapPage(page)} aria-label={`Page ${page}: ${mark === 'skip' ? 'skipped' : label ?? ''}`}>
                    <span className={`thumb ${isSplit ? mode : ''}`}>
                      {src ? <img src={src} alt="" /> : <span className="placeholder" style={{ aspectRatio: aspects[i] || 0.75 }} />}
                      {isSplit && mark !== 'skip' && (
                        <>
                          <span className="half q">Q</span>
                          <span className="half a">A</span>
                        </>
                      )}
                    </span>
                    <span className="badge">{mark === 'skip' ? 'Skip' : label ?? '–'}</span>
                    <span className="pageno">p. {page}</span>
                  </button>
                </li>
              )
            })}
          </ol>

          <h2>3. Create the deck</h2>
          <label className="field">
            Deck name
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
          </label>
          {!progress && (
            <div className="actions">
              <button className="primary" onClick={create} disabled={cards.length === 0}>
                Create Goodnotes deck ({cards.length} cards)
              </button>
            </div>
          )}
          </fieldset>

          {progress && (
            <Progress
              label={progress[0] < progress[1] ? 'Creating deck… card' : 'Packing the deck file…'}
              done={progress[0] < progress[1] ? progress[0] : undefined}
              total={progress[0] < progress[1] ? progress[1] : undefined}
            />
          )}

          {result && (
            <div className="result" role="status">
              <p>
                <strong>Your deck is ready.</strong> {cards.length} cards, {(result.length / 1024 / 1024).toFixed(1)} MB.
              </p>
              <div className="actions">
                {canShareFiles() && (
                  <button className="primary" onClick={() => share(result, outName, GOODNOTES_MIME)}>
                    Open in Goodnotes…
                  </button>
                )}
                <button onClick={() => download(result, outName, GOODNOTES_MIME)}>Download {outName}</button>
              </div>
              <p className="muted">
                On iPad: tap <em>Open in Goodnotes…</em> and choose Goodnotes, or open the downloaded file from the Files app
                and share it to Goodnotes. If Goodnotes asks, import it as a new document.
              </p>
            </div>
          )}
        </>
      )}
    </section>
  )
}
