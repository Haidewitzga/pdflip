function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function format(h: string): string {
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`.toUpperCase()
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  return b
}

/** Random version-4 UUID in Goodnotes' uppercase style. */
export function uuid4(): string {
  const b = randomBytes(16)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  return format(hex(b))
}

/**
 * Random version-5-shaped UUID for canvases. Goodnotes derives a canvas'
 * notes-file id as canvas id + 1, so the low byte is kept away from 0xff.
 */
export function canvasUuid(): string {
  const b = randomBytes(16)
  b[6] = (b[6] & 0x0f) | 0x50
  b[8] = (b[8] & 0x3f) | 0x80
  b[15] = b[15] & 0x7f
  return format(hex(b))
}

/** Interprets a UUID as a 128-bit integer and adds one. */
export function uuidPlusOne(id: string): string {
  const n = BigInt('0x' + id.replace(/-/g, '')) + 1n
  return format(n.toString(16).padStart(32, '0'))
}

export function randomU32(): number {
  return new DataView(randomBytes(4).buffer).getUint32(0)
}

/** Random positive 63-bit integer (used as a per-file device identifier). */
export function randomU63(): bigint {
  const dv = new DataView(randomBytes(8).buffer)
  return dv.getBigUint64(0) & 0x7fffffffffffffffn
}
