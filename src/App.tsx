import { useEffect, useState } from 'react'
import PdfToGoodnotes from './components/PdfToGoodnotes'
import GoodnotesToPdf from './components/GoodnotesToPdf'
import { Privacy } from './components/Legal'
import { testedWith } from './site.config'

type Route = 'to-goodnotes' | 'to-pdf' | 'privacy'
const ROUTES: Route[] = ['to-goodnotes', 'to-pdf', 'privacy']

function currentRoute(): Route {
  const h = location.hash.slice(1) as Route
  return ROUTES.includes(h) ? h : 'to-goodnotes'
}

export default function App() {
  const [route, setRoute] = useState<Route>(currentRoute)
  useEffect(() => {
    const on = () => {
      setRoute(currentRoute())
      window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])

  const tool = route === 'to-goodnotes' || route === 'to-pdf'
  return (
    <>
      <header className="site-header">
        <a href="#to-goodnotes" className="brand" aria-label="PDFlip home">
          <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width={32} height={32} />
          <span>PDFlip</span>
        </a>
        <p className="tagline">Convert Goodnotes flashcards to PDF, and PDFs to Goodnotes flashcards.</p>
      </header>

      <main>
        {tool && (
          <nav className="tabs" aria-label="Converter">
            <a href="#to-goodnotes" aria-current={route === 'to-goodnotes' ? 'page' : undefined}>
              PDF → Goodnotes flashcards
            </a>
            <a href="#to-pdf" aria-current={route === 'to-pdf' ? 'page' : undefined}>
              Goodnotes flashcards → PDF
            </a>
          </nav>
        )}
        {/* Both tools stay mounted so switching tabs keeps your work. */}
        <div hidden={route !== 'to-goodnotes'}>
          <PdfToGoodnotes />
        </div>
        <div hidden={route !== 'to-pdf'}>
          <GoodnotesToPdf />
        </div>
        {route === 'privacy' && <Privacy />}
      </main>

      <footer className="site-footer">
        <p>
          🔒 Your files never leave your device: everything is converted inside your browser. No uploads, no cookies, no
          tracking.
        </p>
        <p>
          PDFlip is an independent project and is not affiliated with, endorsed by, or connected to Goodnotes. Goodnotes
          is a trademark of its respective owner. Experimental – tested with {testedWith}; keep a backup of your original
          decks.
        </p>
        <p className="footer-links">
          <a href="#privacy">Privacy</a> ·{' '}
          <a href="https://github.com/Haidewitzga/pdflip" target="_blank" rel="noreferrer">
            Source code
          </a>
        </p>
      </footer>
    </>
  )
}
