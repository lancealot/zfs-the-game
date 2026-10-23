/**
 * Fletcher-4, ZFS's default block checksum: four 64-bit running sums over
 * the block read as little-endian 32-bit words.
 */
export type Cksum = readonly [bigint, bigint, bigint, bigint]

const MASK = (1n << 64n) - 1n

export function fletcher4(buf: Uint8Array): Cksum {
  let a = 0n
  let b = 0n
  let c = 0n
  let d = 0n
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const words = buf.byteLength >> 2
  for (let i = 0; i < words; i++) {
    a = (a + BigInt(view.getUint32(i * 4, true))) & MASK
    b = (b + a) & MASK
    c = (c + b) & MASK
    d = (d + c) & MASK
  }
  return [a, b, c, d]
}

export const cksumEqual = (x: Cksum, y: Cksum) => x[0] === y[0] && x[1] === y[1] && x[2] === y[2] && x[3] === y[3]

/** zdb style: the four words in hex, colon separated. */
export const cksumHex = (c: Cksum) => c.map((w) => w.toString(16).padStart(16, '0')).join(':')

/** A short tag for labels: the low 32 bits of the last word. */
export const cksumShort = (c: Cksum) => (c[3] & 0xffffffffn).toString(16).padStart(8, '0')
