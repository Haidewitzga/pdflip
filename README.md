# PDFlip

**Convert Goodnotes flashcards to PDF, and PDFs to Goodnotes flashcards.**

PDFlip runs entirely in your browser: your files are never uploaded anywhere. After the first visit it also works
without internet, including when added to the iPad Home Screen.

- **PDF → Goodnotes flashcards**: pick a PDF, mark which pages (or page halves) are questions and answers, and
  download a `.goodnotes` flashcard deck you can open in Goodnotes and study with Smart Learn.
- **Goodnotes flashcards → PDF**: open a deck exported from Goodnotes and get a PDF with all cards (handwriting,
  text boxes and images), either one page per side or question and answer on one page.

> ⚠️ Experimental. The Goodnotes file format is not publicly documented. PDFlip has been tested with Goodnotes 5
> (7.1.27) on iPad. Keep backups of your original decks.

PDFlip is an independent project and is not affiliated with, endorsed by, or connected to Goodnotes.

## Development

```bash
npm install
npm run dev        # local dev server
npm test           # unit tests
npm run build      # production build into dist/
```

To also test against a real deck exported from Goodnotes (never commit personal decks):

```bash
GOODNOTES_SAMPLE=/path/to/deck.goodnotes npm test
```

Pushes to `main` are built, tested and deployed to GitHub Pages by `.github/workflows/deploy.yml`.

## How it works

- `src/lib/pb.ts`, `src/lib/lz4.ts`: schema-less protobuf reader/writer and Apple `bv41` LZ4 decoder
- `src/lib/goodnotes/read.ts`: reads a `.goodnotes` flashcard deck (cards, handwriting, images, text boxes)
- `src/lib/goodnotes/write.ts`: writes a `.goodnotes` flashcard deck whose card sides are images
- `src/lib/deckToPdf.ts`: draws a deck into a PDF (vector handwriting) with pdf-lib
- `src/lib/pdfToCards.ts`: renders PDF pages with pdf.js and builds the deck

The file format notes are in [docs/FORMAT.md](docs/FORMAT.md).

## License

MIT. The bundled DejaVu Sans font (`public/fonts/`) is under its own free license, see
`public/fonts/LICENSE-DejaVu.txt`.
