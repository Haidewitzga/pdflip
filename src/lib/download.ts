/** Offers bytes as a file download (works in Safari on iPad, which saves to Files/Downloads). */
export function download(data: Uint8Array, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** Opens the system share sheet (e.g. "Open in Goodnotes" on iPad) when the browser supports sharing files. */
export async function share(data: Uint8Array, filename: string, type: string): Promise<boolean> {
  const file = new File([data as BlobPart], filename, { type })
  if (!navigator.canShare?.({ files: [file] })) return false
  try {
    await navigator.share({ files: [file] })
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return true
    return false
  }
  return true
}

export function canShareFiles(): boolean {
  try {
    return !!navigator.canShare?.({ files: [new File([], 'x.pdf', { type: 'application/pdf' })] })
  } catch {
    return false
  }
}

export function safeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'flashcards'
}
