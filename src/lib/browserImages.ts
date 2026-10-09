/**
 * Re-encodes a PNG as a JPEG on a white background using the browser's native image codecs.
 * pdf-lib embeds JPEGs without decoding them, which is far faster than its JavaScript PNG
 * decoder. Very large images are also scaled down to a sensible print resolution.
 */
export async function pngToJpeg(data: Uint8Array, maxPx = 2400): Promise<Uint8Array | null> {
  if (!(data[0] === 0x89 && data[1] === 0x50)) return null
  const bitmap = await createImageBitmap(new Blob([data as BlobPart], { type: 'image/png' }))
  const k = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * k))
  canvas.height = Math.max(1, Math.round(bitmap.height * k))
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.9))
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null
}
