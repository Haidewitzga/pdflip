// Decoder for Apple's "bv41" LZ4 framing (libcompression COMPRESSION_LZ4),
// which Goodnotes uses for handwriting stroke data.

function lz4Block(src: Uint8Array, out: number[], expected: number): void {
  const start = out.length
  let i = 0
  while (i < src.length) {
    const token = src[i++]
    let lit = token >> 4
    if (lit === 15) {
      let b
      do {
        b = src[i++]
        lit += b
      } while (b === 255)
    }
    for (let k = 0; k < lit; k++) out.push(src[i++])
    if (i >= src.length || out.length - start >= expected) break
    const off = src[i] | (src[i + 1] << 8)
    i += 2
    let m = token & 15
    if (m === 15) {
      let b
      do {
        b = src[i++]
        m += b
      } while (b === 255)
    }
    m += 4
    if (off === 0 || off > out.length - start) throw new Error('invalid lz4 offset')
    for (let k = 0; k < m; k++) out.push(out[out.length - off])
  }
}

/** Decompresses a sequence of bv41 blocks terminated by "bv4$". */
export function decodeBv41(b: Uint8Array): Uint8Array {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const out: number[] = []
  let i = 0
  // 'b','v','4','1'
  while (i + 12 <= b.length && b[i] === 0x62 && b[i + 1] === 0x76 && b[i + 2] === 0x34 && b[i + 3] === 0x31) {
    const n = dv.getUint32(i + 4, true)
    const c = dv.getUint32(i + 8, true)
    lz4Block(b.subarray(i + 12, i + 12 + c), out, n)
    i += 12 + c
  }
  return Uint8Array.from(out)
}
