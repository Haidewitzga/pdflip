// Checks a chosen file before it is opened: the name must have the right extension, the size must be
// sensible and the first bytes must match the format. Nothing in a file is ever run; this only makes
// sure the readers get the kind of file they expect and that huge files fail early with a clear message.

export const MAX_PDF_BYTES = 300 * 1024 * 1024
export const MAX_DECK_BYTES = 500 * 1024 * 1024

const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`

function startsWith(bytes: Uint8Array, magic: number[], at = 0): boolean {
  return magic.every((b, i) => bytes[at + i] === b)
}

function checkSize(file: { size: number }, max: number) {
  if (file.size === 0) throw new Error('This file is empty.')
  if (file.size > max) throw new Error(`This file is too large (over ${mb(max)}).`)
}

/** Returns the bytes of a PDF file, or throws a message for the user. */
export async function readPdfFile(file: File): Promise<ArrayBuffer> {
  if (!/\.pdf$/i.test(file.name)) throw new Error('Please choose a PDF file (.pdf).')
  checkSize(file, MAX_PDF_BYTES)
  const data = await file.arrayBuffer()
  if (!isPdf(new Uint8Array(data))) throw new Error('This file is not a valid PDF.')
  return data
}

/** Returns the bytes of a .goodnotes file, or throws a message for the user. */
export async function readGoodnotesFile(file: File): Promise<ArrayBuffer> {
  if (!/\.goodnotes$/i.test(file.name)) throw new Error('Please choose a Goodnotes file (.goodnotes).')
  checkSize(file, MAX_DECK_BYTES)
  const data = await file.arrayBuffer()
  if (!isZip(new Uint8Array(data))) throw new Error('This file is not a valid Goodnotes file.')
  return data
}

/** PDFs start with "%PDF-"; readers accept it within the first 1024 bytes. */
export function isPdf(bytes: Uint8Array): boolean {
  const magic = [0x25, 0x50, 0x44, 0x46, 0x2d]
  for (let i = 0; i + magic.length <= Math.min(bytes.length, 1024); i++) if (startsWith(bytes, magic, i)) return true
  return false
}

/** A .goodnotes file is a zip archive, which starts with a local file header "PK\3\4". */
export function isZip(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])
}
