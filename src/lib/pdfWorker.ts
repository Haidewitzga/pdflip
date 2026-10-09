// pdf.js's background worker, plus one addition: it passes pdf.js's warnings to the page. pdf.js
// logs a warning whenever it has to give up on part of a PDF (a font, an image, an unsupported
// feature) and then carries on silently; the page cannot see the worker's console otherwise.
// The page ignores nothing here; pdf.js ignores these extra messages (they have no target).
import 'pdfjs-dist/build/pdf.worker.min.mjs'

const log = console.log.bind(console)
console.log = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].startsWith('Warning: ')) {
    ;(self as unknown as { postMessage: (m: unknown) => void }).postMessage({ pdflipWarning: args[0].slice(9, 400) })
  }
  log(...args)
}
