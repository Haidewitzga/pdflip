import { PDFDocument, PDFFont, StandardFonts } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import type { FontFamily } from './rtf'

export interface FontStyle {
  family: FontFamily
  bold: boolean
  italic: boolean
}

const STANDARD: Record<FontFamily, [StandardFonts, StandardFonts, StandardFonts, StandardFonts]> = {
  // regular, bold, italic, bold italic
  sans: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  serif: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  mono: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
}

export const PLAIN: FontStyle = { family: 'sans', bold: false, italic: false }

/** A piece of text that can be drawn with a single font. */
export interface Segment {
  text: string
  font: PDFFont
}

/**
 * Fonts for a PDF: the 14 standard PDF fonts (Helvetica, Times, Courier and their bold/italic
 * variants, which every PDF reader has, so nothing is embedded) as close matches for the fonts
 * Goodnotes uses, plus an embedded Unicode font for characters those cannot show (θ, Ω, ∑ …).
 */
export class FontBook {
  private standard = new Map<StandardFonts, PDFFont>()
  private fallback: PDFFont | null | undefined
  private encodable = new Map<PDFFont, Map<string, boolean>>()
  /** Characters no available font can show; they are drawn as "?" and listed in problem reports. */
  readonly unsupported = new Set<string>()

  constructor(
    private pdf: PDFDocument,
    private loadUnicodeFont?: () => Promise<Uint8Array>,
  ) {}

  async font(style: FontStyle): Promise<PDFFont> {
    const name = STANDARD[style.family][(style.bold ? 1 : 0) + (style.italic ? 2 : 0)]
    let f = this.standard.get(name)
    if (!f) {
      f = await this.pdf.embedFont(name)
      this.standard.set(name, f)
    }
    return f
  }

  private canEncode(font: PDFFont, ch: string): boolean {
    let cache = this.encodable.get(font)
    if (!cache) this.encodable.set(font, (cache = new Map()))
    let ok = cache.get(ch)
    if (ok === undefined) {
      try {
        font.encodeText(ch)
        ok = true
      } catch {
        ok = false
      }
      cache.set(ch, ok)
    }
    return ok
  }

  /** Whether the embedded Unicode font has a real glyph (not an empty box) for a character. */
  private hasGlyph(font: PDFFont, ch: string): boolean {
    const fk = (font as unknown as { embedder?: { font?: { hasGlyphForCodePoint?: (cp: number) => boolean } } }).embedder?.font
    return fk?.hasGlyphForCodePoint ? fk.hasGlyphForCodePoint(ch.codePointAt(0)!) : this.canEncode(font, ch)
  }

  private async unicodeFont(): Promise<PDFFont | null> {
    if (this.fallback === undefined) {
      this.fallback = null
      if (this.loadUnicodeFont) {
        try {
          this.pdf.registerFontkit(fontkit)
          this.fallback = await this.pdf.embedFont(await this.loadUnicodeFont(), { subset: true })
        } catch {
          // no Unicode font: such characters become "?"
        }
      }
    }
    return this.fallback
  }

  /** Splits text into pieces drawable with the style's font, using the Unicode font where needed. */
  async segments(text: string, style: FontStyle): Promise<Segment[]> {
    const primary = await this.font(style)
    const out: Segment[] = []
    const push = (t: string, f: PDFFont) => {
      const last = out[out.length - 1]
      if (last && last.font === f) last.text += t
      else out.push({ text: t, font: f })
    }
    for (const ch of text) {
      if (ch === '\n' || this.canEncode(primary, ch)) {
        push(ch, primary)
        continue
      }
      const uni = await this.unicodeFont()
      if (uni && this.hasGlyph(uni, ch)) push(ch, uni)
      else {
        // whitespace and invisible formatting characters are not worth a "?" or a report
        if (/[\s\p{Cf}]/u.test(ch)) continue
        this.unsupported.add(ch)
        push('?', primary)
      }
    }
    return out
  }

  /** Width of text at a size, accounting for Unicode fallback characters. */
  async width(text: string, style: FontStyle, size: number): Promise<number> {
    let w = 0
    for (const s of await this.segments(text, style)) w += s.font.widthOfTextAtSize(s.text, size)
    return w
  }
}
