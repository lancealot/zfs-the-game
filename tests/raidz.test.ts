import { describe, it, expect } from 'vitest'
import { raidzMap, reconstructP, reconstructPQ, qParity, gfMul, gfDiv } from '../src/zfs/raidz'

const count = (m: ReturnType<typeof raidzMap>, k: string) => m.cells.filter((c) => c.kind === k).length

describe('raidzMap', () => {
  it('one sector on a 4-wide raidz1: 1 data + 1 parity, no padding', () => {
    const m = raidzMap([7], 4, 1)
    expect(count(m, 'D')).toBe(1)
    expect(count(m, 'P')).toBe(1)
    expect(m.asize).toBe(2)
    expect(count(m, 'skip')).toBe(0)
  })

  it('two sectors on raidz1: 3 sectors rounded up to 4 with one skip sector', () => {
    const m = raidzMap([1, 2], 4, 1)
    expect(m.asize).toBe(4)
    expect(count(m, 'skip')).toBe(1)
  })

  it('five sectors on a 4-wide raidz1: two rows, short last column, one skip', () => {
    const m = raidzMap([1, 2, 3, 4, 5], 4, 1)
    expect(count(m, 'D')).toBe(5)
    expect(count(m, 'P')).toBe(2)
    expect(m.asize).toBe(8)
    expect(count(m, 'skip')).toBe(1)
    // Data is laid out column by column: sectors 0,1 on the first data disk.
    const d = m.cells.filter((c) => c.kind === 'D')
    expect(d[0].disk).toBe(d[1].disk)
    expect(d[1].row).toBe(d[0].row + 1)
  })

  it('every sector of the allocation lands on a unique disk/row', () => {
    for (let s = 1; s <= 13; s++) {
      for (const [w, p] of [[4, 1], [5, 1], [6, 2], [7, 3]]) {
        const m = raidzMap(Array.from({ length: s }, (_, i) => i + 1), w, p, 3)
        const keys = m.cells.map((c) => `${c.disk}:${c.row}`)
        expect(new Set(keys).size).toBe(keys.length)
        expect(m.cells.length).toBe(m.asize)
        expect(m.asize % (p + 1)).toBe(0)
      }
    }
  })

  it('P parity is the XOR of each row', () => {
    const m = raidzMap([0b1010, 0b0110, 0b1111], 4, 1)
    const p = m.cells.find((c) => c.kind === 'P')!
    expect(p.value).toBe(0b1010 ^ 0b0110 ^ 0b1111)
  })
})

describe('reconstruction', () => {
  it('rebuilds any single missing sector from P', () => {
    const row = [0x3c, 0xa5, 0x0f, 0x81]
    const p = row.reduce((a, b) => a ^ b, 0)
    for (let i = 0; i < row.length; i++) {
      const damaged = row.map((v, j) => (j === i ? null : v))
      expect(reconstructP(damaged, p)).toBe(row[i])
    }
  })

  it('GF(2^8) multiply and divide are inverses', () => {
    for (let a = 1; a < 256; a += 7) for (let b = 1; b < 256; b += 11) expect(gfDiv(gfMul(a, b), b)).toBe(a)
  })

  it('rebuilds any two missing sectors from P and Q', () => {
    const row = [0x12, 0xf0, 0x7e, 0x33, 0xc9]
    const p = row.reduce((a, b) => a ^ b, 0)
    const q = qParity(row)
    for (let x = 0; x < row.length; x++) {
      for (let y = x + 1; y < row.length; y++) {
        const damaged = row.map((v, j) => (j === x || j === y ? null : v))
        expect(reconstructPQ(damaged, x, y, p, q)).toEqual([row[x], row[y]])
      }
    }
  })
})

describe('raidz2 layout + reconstruction', () => {
  it('rebuilds any two lost data sectors of any row, short columns included', () => {
    for (let s = 3; s <= 14; s++) {
      const data = Array.from({ length: s }, (_, i) => (i * 73 + 19) & 0xff || 1)
      const m = raidzMap(data, 5, 2, s)
      const dcells = m.cells.filter((c) => c.kind === 'D')
      const cols = [...new Set(dcells.map((c) => c.col))].sort((a, b) => a - b)
      for (const p of m.cells.filter((c) => c.kind === 'P')) {
        const q = m.cells.find((c) => c.kind === 'Q' && c.k === p.k)!
        const ordered = cols.map((col) => dcells.find((c) => c.col === col && c.k === p.k) ?? null)
        const present = ordered.map((c, i) => (c ? i : -1)).filter((i) => i >= 0)
        for (let a = 0; a < present.length; a++) {
          for (let b = a + 1; b < present.length; b++) {
            const [x, y] = [present[a], present[b]]
            const row = ordered.map((c, i) => (i === x || i === y ? null : (c?.value ?? 0)))
            expect(reconstructPQ(row, x, y, p.value, q.value)).toEqual([ordered[x]!.value, ordered[y]!.value])
          }
        }
      }
    }
  })
})
