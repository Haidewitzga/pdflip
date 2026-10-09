import { useState } from 'react'
import { readDeck } from '../lib/goodnotes/read'
import { readGoodnotesFile } from '../lib/fileCheck'
import type { Deck, Skipped } from '../lib/goodnotes/model'
import { deckToPdf, type PdfLayout } from '../lib/deckToPdf'
import { pngToJpeg } from '../lib/browserImages'
import { canShareFiles, download, safeFilename, share } from '../lib/download'
import { openPdf, renderPage } from '../lib/pdfToCards'
import FilePicker from './FilePicker'
import Progress from './Progress'
import ProblemReport from './ProblemReport'
import {
  countOf,
  isUnexpected,
  unexpectedErrorProblem,
  unreadablePartProblems,
  unsupportedCharactersProblem,
  type Problem,
} from '../lib/problems'

type Status =
  | { step: 'empty' }
  | { step: 'reading' }
  | { step: 'ready' }
  | { step: 'creating'; done: number; total: number }
  | { step: 'saving' }
  | { step: 'done'; pdf: Uint8Array; preview: string[] }

export default function GoodnotesToPdf() {
  const [deck, setDeck] = useState<Deck | null>(null)
  const [fileName, setFileName] = useState('')
  const [layout, setLayout] = useState<PdfLayout>('pages')
  const [labels, setLabels] = useState(true)
  const [error, setError] = useState('')
  const [status, setStatus] = useState<Status>({ step: 'empty' })
  /** Problems found while reading the deck or creating the PDF (unknown parts, characters, errors). */
  const [problems, setProblems] = useState<Problem[]>([])

  const working = status.step === 'reading' || status.step === 'creating' || status.step === 'saving'

  async function onFile(file: File) {
    setError('')
    setProblems([])
    setDeck(null)
    setFileName(file.name)
    setStatus({ step: 'reading' })
    try {
      const d = await readDeck(await readGoodnotesFile(file))
      setDeck(d)
      setProblems(unreadablePartProblems(d.skipped ?? []))
      setStatus({ step: 'ready' })
    } catch (e) {
      setFileName('')
      setError(e instanceof Error ? e.message : String(e))
      if (isUnexpected(e)) setProblems([unexpectedErrorProblem('goodnotes-to-pdf', 'reading the deck', e)])
      setStatus({ step: 'empty' })
    }
  }

  function clearFile() {
    setProblems([])
    setDeck(null)
    setFileName('')
    setError('')
    setStatus({ step: 'empty' })
  }

  /** Any change to the settings invalidates a finished PDF. */
  function change(fn: () => void) {
    fn()
    if (status.step === 'done') setStatus({ step: 'ready' })
  }

  async function create() {
    if (!deck) return
    setError('')
    // problems from an earlier PDF of this deck are found again
    setProblems(unreadablePartProblems(deck.skipped ?? []))
    setStatus({ step: 'creating', done: 0, total: deck.cards.length })
    try {
      const pdf = await deckToPdf(deck, {
        layout,
        labels,
        convertImage: pngToJpeg,
        loadUnicodeFont: () =>
          fetch(`${import.meta.env.BASE_URL}fonts/DejaVuSans.ttf`).then(async (r) => {
            if (!r.ok) throw new Error('font not available')
            return new Uint8Array(await r.arrayBuffer())
          }),
        onProgress: (done, total) => setStatus(done === total ? { step: 'saving' } : { step: 'creating', done, total }),
        onUnsupportedCharacters: (chars) => setProblems((ps) => [...ps, unsupportedCharactersProblem(chars)]),
      })
      const preview = await renderPreview(pdf, layout === 'pages' ? 2 : 1).catch(() => [])
      setStatus({ step: 'done', pdf, preview })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      if (isUnexpected(e)) setProblems((ps) => [...ps, unexpectedErrorProblem('goodnotes-to-pdf', 'creating the PDF', e)])
      setStatus({ step: 'ready' })
    }
  }

  const unreadable = problems.filter((p) => p.kind === 'unreadable-part')
  const otherProblems = problems.filter((p) => p.kind !== 'unreadable-part')

  const outName = `${safeFilename(deck?.title || fileName.replace(/\.goodnotes$/i, '') || 'Flashcards')}.pdf`

  return (
    <section className="tool">
      <h1>Turn Goodnotes flashcards into a PDF</h1>
      <p className="lead">
        In Goodnotes, export your flashcard deck as a <em>.goodnotes</em> file (Share → Export → Goodnotes), then open it
        here. Handwriting, text and images are converted to a PDF you can print or share.
      </p>

      <fieldset className="settings" disabled={working}>
        <FilePicker
          label="Choose a .goodnotes file"
          hint="or drop it here"
          onFile={onFile}
          fileName={fileName}
          onClear={clearFile}
        />
      </fieldset>

      {error && <p className="error" role="alert">{error}</p>}
      <ProblemReport key={problemKey(otherProblems)} problems={otherProblems} heading="PDFlip could not handle everything in this deck" />
      {status.step === 'reading' && <Progress label="Reading deck…" />}

      {deck && (
        <>
          <p>
            <strong>{deck.title}</strong> · {deck.cards.length} card{deck.cards.length === 1 ? '' : 's'}
          </p>

          {deck.skipped && deck.skipped.length > 0 && (
            <ProblemReport
              key={problemKey(unreadable)}
              problems={unreadable}
              tone="warning"
              heading="Some parts could not be read and will be missing from the PDF. They are still in your Goodnotes deck."
            >
              <SkippedList skipped={deck.skipped} />
            </ProblemReport>
          )}

          <fieldset className="settings" disabled={working}>
            <h2>1. Choose a layout</h2>
            <div className="modes" role="radiogroup" aria-label="PDF layout">
              <button role="radio" aria-checked={layout === 'pages'} className="mode" onClick={() => change(() => setLayout('pages'))}>
                <strong>Question page, then answer page</strong>
                <span>Two pages per card – good for flipping through.</span>
              </button>
              <button role="radio" aria-checked={layout === 'stacked'} className="mode" onClick={() => change(() => setLayout('stacked'))}>
                <strong>Question and answer on one page</strong>
                <span>One page per card – good for reviewing and printing.</span>
              </button>
            </div>
            <label className="check">
              <input type="checkbox" checked={labels} onChange={(e) => change(() => setLabels(e.target.checked))} /> Show card
              numbers
            </label>

            <h2>2. Create the PDF</h2>
            {status.step !== 'done' && !working && (
              <div className="actions">
                <button className="primary" onClick={create}>
                  Create PDF ({deck.cards.length} cards)
                </button>
              </div>
            )}
          </fieldset>

          {status.step === 'creating' && <Progress label="Creating PDF… card" done={status.done} total={status.total} />}
          {status.step === 'saving' && <Progress label="Finishing PDF…" />}

          {status.step === 'done' && (
            <div className="result" role="status">
              <p>
                <strong>Your PDF is ready.</strong> {deck.cards.length} cards, {(status.pdf.length / 1024 / 1024).toFixed(1)} MB.
              </p>
              {status.preview.length > 0 && (
                <div className="preview" aria-label="Preview of the first card">
                  {status.preview.map((src, i) => (
                    <img key={i} src={src} alt={`Preview page ${i + 1}`} />
                  ))}
                </div>
              )}
              <div className="actions">
                {canShareFiles() && (
                  <button className="primary" onClick={() => share(status.pdf, outName, 'application/pdf')}>
                    Share PDF…
                  </button>
                )}
                <button className={canShareFiles() ? '' : 'primary'} onClick={() => download(status.pdf, outName, 'application/pdf')}>
                  Download {outName}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  )
}

const SHOWN = 8

const problemKey = (ps: Problem[]) => ps.map((p) => p.signature).join('|')

/** Lists the parts of cards that could not be read and will be missing from the PDF. */
function SkippedList({ skipped }: { skipped: Skipped[] }) {
  return (
    <ul>
      {skipped.slice(0, SHOWN).map((s) => (
        <li key={`${s.card}-${s.side}-${s.what}`}>
          Card {s.card}, {s.side}: {countOf(s.count, s.what)}
        </li>
      ))}
      {skipped.length > SHOWN && <li>…and {skipped.length - SHOWN} more</li>}
    </ul>
  )
}

async function renderPreview(bytes: Uint8Array, pages: number): Promise<string[]> {
  const doc = await openPdf(bytes.slice().buffer)
  const out: string[] = []
  for (let p = 1; p <= Math.min(pages, doc.numPages); p++) out.push((await renderPage(doc, p, 900)).toDataURL('image/jpeg', 0.85))
  await doc.destroy()
  return out
}
