import { useEffect, useState } from 'react'
import { readDeck } from '../lib/goodnotes/read'
import type { Deck } from '../lib/goodnotes/model'
import { deckToPdf, type PdfLayout } from '../lib/deckToPdf'
import { canShareFiles, download, safeFilename, share } from '../lib/download'
import { openPdf, renderPage } from '../lib/pdfToCards'
import FilePicker from './FilePicker'

export default function GoodnotesToPdf() {
  const [deck, setDeck] = useState<Deck | null>(null)
  const [fileName, setFileName] = useState('')
  const [layout, setLayout] = useState<PdfLayout>('pages')
  const [labels, setLabels] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [pdf, setPdf] = useState<Uint8Array | null>(null)
  const [preview, setPreview] = useState<string[]>([])

  async function onFile(file: File) {
    setError('')
    setDeck(null)
    setPdf(null)
    setFileName(file.name)
    try {
      setDeck(await readDeck(await file.arrayBuffer()))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // Regenerate the PDF whenever the deck or the options change.
  useEffect(() => {
    if (!deck) return
    let cancelled = false
    setBusy(true)
    setPdf(null)
    deckToPdf(deck, { layout, labels })
      .then(async (bytes) => {
        if (cancelled) return
        setPdf(bytes)
        setPreview(await renderPreview(bytes, layout === 'pages' ? 2 : 1))
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setBusy(false))
    return () => {
      cancelled = true
    }
  }, [deck, layout, labels])

  const outName = `${safeFilename(deck?.title || fileName.replace(/\.goodnotes$/i, '') || 'Flashcards')}.pdf`

  return (
    <section className="tool">
      <h1>Turn Goodnotes flashcards into a PDF</h1>
      <p className="lead">
        In Goodnotes, export your flashcard deck as a <em>.goodnotes</em> file (Share → Export → Goodnotes), then open it
        here. Handwriting, text and images are converted to a PDF you can print or share.
      </p>

      <FilePicker label={fileName || 'Choose a .goodnotes file'} hint="or drop it here" onFile={onFile} />

      {error && <p className="error" role="alert">{error}</p>}

      {deck && (
        <>
          <p>
            <strong>{deck.title}</strong> · {deck.cards.length} card{deck.cards.length === 1 ? '' : 's'}
          </p>

          <h2>Layout</h2>
          <div className="modes" role="radiogroup" aria-label="PDF layout">
            <button role="radio" aria-checked={layout === 'pages'} className="mode" onClick={() => setLayout('pages')}>
              <strong>Question page, then answer page</strong>
              <span>Two pages per card – good for flipping through.</span>
            </button>
            <button role="radio" aria-checked={layout === 'stacked'} className="mode" onClick={() => setLayout('stacked')}>
              <strong>Question and answer on one page</strong>
              <span>One page per card – good for reviewing and printing.</span>
            </button>
          </div>
          <label className="check">
            <input type="checkbox" checked={labels} onChange={(e) => setLabels(e.target.checked)} /> Show card numbers
          </label>

          {preview.length > 0 && (
            <div className="preview" aria-label="Preview of the first card">
              {preview.map((src, i) => (
                <img key={i} src={src} alt={`Preview page ${i + 1}`} />
              ))}
            </div>
          )}

          <div className="actions">
            {busy && <span className="muted">Creating PDF…</span>}
            {pdf && canShareFiles() && (
              <button className="primary" onClick={() => share(pdf, outName, 'application/pdf')}>
                Share PDF…
              </button>
            )}
            {pdf && (
              <button className={canShareFiles() ? '' : 'primary'} onClick={() => download(pdf, outName, 'application/pdf')}>
                Download {outName}
              </button>
            )}
          </div>
        </>
      )}
    </section>
  )
}

async function renderPreview(bytes: Uint8Array, pages: number): Promise<string[]> {
  const doc = await openPdf(bytes.slice().buffer)
  const out: string[] = []
  for (let p = 1; p <= Math.min(pages, doc.numPages); p++) out.push((await renderPage(doc, p, 900)).toDataURL('image/jpeg', 0.85))
  await doc.destroy()
  return out
}
