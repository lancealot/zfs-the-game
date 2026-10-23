import { describe, it, expect } from 'vitest'
import { fletcher4, cksumEqual, cksumHex } from '../src/zfs/checksum'

const words = (...w: number[]) => {
  const b = new Uint8Array(w.length * 4)
  const v = new DataView(b.buffer)
  w.forEach((x, i) => v.setUint32(i * 4, x, true))
  return b
}

describe('fletcher4', () => {
  it('computes the four running sums', () => {
    // a: 1,3,6,10  b: 1,4,10,20  c: 1,5,15,35  d: 1,6,21,56
    expect(fletcher4(words(1, 2, 3, 4))).toEqual([10n, 20n, 35n, 56n])
  })

  it('wraps at 64 bits', () => {
    const big = new Array(64).fill(0xffffffff)
    const [a] = fletcher4(words(...big))
    expect(a).toBe(64n * 0xffffffffn)
    const many = new Uint8Array(4 * 200000).fill(0xff)
    const c = fletcher4(many)
    for (const w of c) expect(w < 1n << 64n).toBe(true)
  })

  it('is position sensitive, unlike a plain sum', () => {
    expect(cksumEqual(fletcher4(words(1, 2)), fletcher4(words(2, 1)))).toBe(false)
  })

  it('formats like zdb', () => {
    expect(cksumHex(fletcher4(words(1, 2, 3, 4)))).toBe('a:14:23:38')
  })
})
