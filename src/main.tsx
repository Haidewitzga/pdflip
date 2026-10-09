import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// A file dropped outside a drop area would otherwise be opened by the browser in place of the site.
for (const type of ['dragover', 'drop']) window.addEventListener(type, (e) => e.preventDefault())

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Keep a copy of the site on the device so it also opens without internet (see sw/sw.template.js).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      // offline use is a bonus; the site works the same without it
    })
  })
}
