// Minimal schema-less Protocol Buffers reader/writer.
// Goodnotes stores its data as protobuf without a published schema, so we
// work with raw field numbers (see docs/FORMAT.md).

export type Field =
  | { f: number; t: 0; v: bigint }
  | { f: number; t: 1 | 5 | 2; v: Uint8Array }

const utf8 = new TextDecoder()
const utf8enc = new TextEncoder()

function readVarint(b: Uint8Array, i: number): [bigint, number] {
  let r = 0n
  let s = 0n
  for (;;) {
    if (i >= b.length) throw new Error('truncated varint')
    const c = b[i++]
    r |= BigInt(c & 0x7f) << s
    s += 7n
    if (c < 0x80) return [r, i]
  }
}

/** Parses one message into its fields. Throws if the bytes are not valid protobuf. */
export function parse(b: Uint8Array): Field[] {
  const out: Field[] = []
  let i = 0
  while (i < b.length) {
    const [key, j] = readVarint(b, i)
    i = j
    const f = Number(key >> 3n)
    const t = Number(key & 7n)
    if (f === 0) throw new Error('invalid field 0')
    if (t === 0) {
      const [v, k] = readVarint(b, i)
      out.push({ f, t, v })
      i = k
    } else if (t === 1 || t === 5) {
      const n = t === 1 ? 8 : 4
      if (i + n > b.length) throw new Error('truncated fixed')
      out.push({ f, t, v: b.subarray(i, i + n) })
      i += n
    } else if (t === 2) {
      const [len, k] = readVarint(b, i)
      i = k
      const end = i + Number(len)
      if (end > b.length) throw new Error('truncated bytes')
      out.push({ f, t, v: b.subarray(i, end) })
      i = end
    } else {
      throw new Error(`unsupported wire type ${t}`)
    }
  }
  return out
}

export function tryParse(b: Uint8Array): Field[] | null {
  try {
    return parse(b)
  } catch {
    return null
  }
}

/** Reads a stream of varint-length-prefixed messages. */
export function readStream(b: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = []
  let i = 0
  while (i < b.length) {
    const [len, j] = readVarint(b, i)
    const end = j + Number(len)
    if (end > b.length) throw new Error('truncated stream')
    out.push(b.subarray(j, end))
    i = end
  }
  return out
}

/** Convenience view over a parsed message: first value per field number. */
export class View {
  readonly fields: Field[]
  constructor(b: Uint8Array | Field[]) {
    this.fields = b instanceof Uint8Array ? parse(b) : b
  }
  static try(b: Uint8Array | undefined): View | null {
    if (!b) return null
    const p = tryParse(b)
    return p ? new View(p) : null
  }
  has(f: number): boolean {
    return this.fields.some((x) => x.f === f)
  }
  raw(f: number): Field | undefined {
    return this.fields.find((x) => x.f === f)
  }
  bytes(f: number): Uint8Array | undefined {
    const x = this.raw(f)
    return x && x.t !== 0 ? x.v : undefined
  }
  str(f: number): string | undefined {
    const b = this.bytes(f)
    return b ? utf8.decode(b) : undefined
  }
  int(f: number): bigint | undefined {
    const x = this.raw(f)
    return x && x.t === 0 ? x.v : undefined
  }
  num(f: number, dflt = 0): number {
    const x = this.raw(f)
    if (!x) return dflt
    if (x.t === 0) return Number(x.v)
    const dv = new DataView(x.v.buffer, x.v.byteOffset, x.v.byteLength)
    if (x.t === 5) return dv.getFloat32(0, true)
    if (x.t === 1) return dv.getFloat64(0, true)
    return dflt
  }
  msg(f: number): View | null {
    return View.try(this.bytes(f))
  }
}

// ---------------------------------------------------------------- writer

function varint(n: bigint | number): number[] {
  let v = BigInt(n)
  if (v < 0n) v += 1n << 64n
  const out: number[] = []
  for (;;) {
    const b = Number(v & 0x7fn)
    v >>= 7n
    if (v) out.push(b | 0x80)
    else {
      out.push(b)
      return out
    }
  }
}

function concat(parts: (Uint8Array | number[])[]): Uint8Array {
  const len = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(len)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Builds a protobuf message field by field, preserving the given order. */
export class Msg {
  private parts: (Uint8Array | number[])[] = []

  int(f: number, v: bigint | number): this {
    this.parts.push(varint((f << 3) | 0), varint(v))
    return this
  }
  bytes(f: number, v: Uint8Array | Msg | string): this {
    const b = v instanceof Msg ? v.encode() : typeof v === 'string' ? utf8enc.encode(v) : v
    this.parts.push(varint((f << 3) | 2), varint(b.length), b)
    return this
  }
  f32(f: number, v: number): this {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setFloat32(0, v, true)
    this.parts.push(varint((f << 3) | 5), b)
    return this
  }
  f64(f: number, v: number): this {
    const b = new Uint8Array(8)
    new DataView(b.buffer).setFloat64(0, v, true)
    this.parts.push(varint((f << 3) | 1), b)
    return this
  }
  encode(): Uint8Array {
    return concat(this.parts)
  }
}

/** Writes messages as a varint-length-prefixed stream. */
export function writeStream(msgs: (Msg | Uint8Array)[]): Uint8Array {
  const parts: (Uint8Array | number[])[] = []
  for (const m of msgs) {
    const b = m instanceof Msg ? m.encode() : m
    parts.push(varint(b.length), b)
  }
  return concat(parts)
}
