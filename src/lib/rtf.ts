// Reader for the RTF Goodnotes (Apple's Cocoa text system) stores in text boxes.
// Produces styled runs: text plus font family, bold, italic, size and colour.

export type FontFamily = 'sans' | 'serif' | 'mono'

export interface TextRun {
  text: string
  family: FontFamily
  bold: boolean
  italic: boolean
  /** Font size in points. */
  size: number
  color: [number, number, number]
}

interface FontDef {
  family: FontFamily
  bold: boolean
  italic: boolean
}

interface State {
  font: number
  bold: boolean
  italic: boolean
  size: number
  color: number
  /** Number of fallback characters to skip after a \u escape. */
  uc: number
  /** Inside a destination we don't print (font table, colour table, \*...). */
  skip: boolean
  dest: '' | 'fonttbl' | 'colortbl'
}

/** Maps a font name (often a PostScript name such as "HelveticaNeue-BoldItalic") to a family and style. */
export function classifyFont(name: string): FontDef {
  const n = name.toLowerCase()
  const family: FontFamily = /courier|mono|menlo|monaco|consolas|typewriter/.test(n)
    ? 'mono'
    : /times|georgia|serif|palatino|baskerville|garamond|cambria|didot|charter|hoefler|bodoni|bookman/.test(n) && !/sans/.test(n)
      ? 'serif'
      : 'sans'
  return { family, bold: /bold|heavy|black|semibold|demi/.test(n), italic: /italic|oblique/.test(n) }
}

const CP1252 = new TextDecoder('windows-1252')
const IGNORED_DESTINATIONS = new Set(['expandedcolortbl', 'stylesheet', 'info', 'pict', 'header', 'footer', 'listtable', 'listoverridetable'])

export function parseRtf(rtf: string): TextRun[] {
  const fonts = new Map<number, FontDef>()
  const colors: ([number, number, number] | null)[] = []
  let pendingColor: [number, number, number] | null = null
  let fontIndex = 0
  let fontName = ''

  let st: State = { font: 0, bold: false, italic: false, size: 12, color: 0, uc: 1, skip: false, dest: '' }
  const stack: State[] = []
  const runs: TextRun[] = []
  let skipChars = 0

  const emit = (text: string) => {
    if (st.skip) {
      if (st.dest === 'fonttbl') {
        for (const ch of text) {
          if (ch === ';') {
            fonts.set(fontIndex, classifyFont(fontName.trim()))
            fontName = ''
          } else fontName += ch
        }
      } else if (st.dest === 'colortbl') {
        for (const ch of text) {
          if (ch === ';') {
            colors.push(pendingColor)
            pendingColor = null
          }
        }
      }
      return
    }
    const def = fonts.get(st.font) ?? { family: 'sans' as FontFamily, bold: false, italic: false }
    const color = colors[st.color] ?? [0, 0, 0]
    const run: TextRun = { text, family: def.family, bold: st.bold || def.bold, italic: st.italic || def.italic, size: st.size, color }
    const last = runs[runs.length - 1]
    if (
      last &&
      last.family === run.family &&
      last.bold === run.bold &&
      last.italic === run.italic &&
      last.size === run.size &&
      last.color.join() === run.color.join()
    )
      last.text += text
    else runs.push(run)
  }

  const putChar = (ch: string) => {
    if (skipChars > 0) {
      skipChars--
      return
    }
    emit(ch)
  }

  let i = 0
  let groupStart = false
  while (i < rtf.length) {
    const c = rtf[i]
    if (c === '{') {
      stack.push(st)
      st = { ...st }
      groupStart = true
      i++
      continue
    }
    if (c === '}') {
      st = stack.pop() ?? st
      groupStart = false
      i++
      continue
    }
    if (c === '\\') {
      const next = rtf[i + 1]
      if (next === undefined) break
      // control symbols
      if (next === '\\' || next === '{' || next === '}') {
        putChar(next)
        i += 2
        groupStart = false
        continue
      }
      if (next === "'") {
        const hex = rtf.slice(i + 2, i + 4)
        putChar(CP1252.decode(new Uint8Array([parseInt(hex, 16)])))
        i += 4
        groupStart = false
        continue
      }
      if (next === '\n' || next === '\r') {
        putChar('\n')
        i += 2
        continue
      }
      if (next === '*') {
        st.skip = true
        st.dest = ''
        i += 2
        continue
      }
      if (next === '~') {
        putChar(' ')
        i += 2
        continue
      }
      if (!/[a-z]/i.test(next)) {
        i += 2 // other control symbols (\-, \_ …) are ignored
        continue
      }
      // control word
      let j = i + 1
      while (j < rtf.length && /[a-z]/i.test(rtf[j])) j++
      const word = rtf.slice(i + 1, j)
      let param: number | null = null
      const m = /^-?\d+/.exec(rtf.slice(j))
      if (m) {
        param = Number(m[0])
        j += m[0].length
      }
      if (rtf[j] === ' ') j++
      i = j
      const atGroupStart = groupStart
      groupStart = false

      if (atGroupStart && (word === 'fonttbl' || word === 'colortbl')) {
        st.skip = true
        st.dest = word
        continue
      }
      if (atGroupStart && IGNORED_DESTINATIONS.has(word)) {
        st.skip = true
        st.dest = ''
        continue
      }
      switch (word) {
        case 'f':
          if (st.dest === 'fonttbl') {
            fontIndex = param ?? 0
            fontName = ''
          } else st.font = param ?? 0
          break
        case 'red':
        case 'green':
        case 'blue': {
          pendingColor ??= [0, 0, 0]
          const k = word === 'red' ? 0 : word === 'green' ? 1 : 2
          pendingColor[k] = (param ?? 0) / 255
          break
        }
        case 'b':
          st.bold = param !== 0
          break
        case 'i':
          st.italic = param !== 0
          break
        case 'fs':
          st.size = (param ?? 24) / 2
          break
        case 'cf':
          st.color = param ?? 0
          break
        case 'plain':
          st.bold = false
          st.italic = false
          st.size = 12
          break
        case 'par':
        case 'line':
          putChar('\n')
          break
        case 'tab':
          putChar('\t')
          break
        case 'uc':
          st.uc = param ?? 1
          break
        case 'u': {
          const code = ((param ?? 0) + 65536) % 65536
          putChar(String.fromCharCode(code))
          skipChars = st.uc
          break
        }
        default:
          break // formatting we don't use (tab stops, paragraph settings …)
      }
      continue
    }
    if (c === '\n' || c === '\r') {
      i++ // raw line breaks in RTF source are not text
      continue
    }
    groupStart = false
    putChar(c)
    i++
  }

  // Trim leading/trailing whitespace of the whole text
  while (runs.length && !runs[0].text.trimStart()) runs.shift()
  while (runs.length && !runs[runs.length - 1].text.trimEnd()) runs.pop()
  if (runs.length) {
    runs[0].text = runs[0].text.trimStart()
    runs[runs.length - 1].text = runs[runs.length - 1].text.trimEnd()
  }
  return runs
}
