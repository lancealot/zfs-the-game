import { describe, it, expect } from 'vitest'
import { Arc, Lru } from '../src/zfs/arc'

describe('Arc', () => {
  it('a second access promotes a block from MRU to MFU', () => {
    const a = new Arc<string>(4)
    expect(a.access('x').hit).toBe(false)
    expect(a.where('x')).toBe('T1')
    expect(a.access('x').hit).toBe(true)
    expect(a.where('x')).toBe('T2')
  })

  it('keeps its invariants under a random workload', () => {
    const c = 6
    const a = new Arc<number>(c)
    let seed = 42
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    for (let i = 0; i < 5000; i++) {
      a.access(Math.floor(rnd() * rnd() * 30))
      expect(a.t1.length + a.t2.length).toBeLessThanOrEqual(c)
      expect(a.t1.length + a.b1.length).toBeLessThanOrEqual(c)
      expect(a.t1.length + a.t2.length + a.b1.length + a.b2.length).toBeLessThanOrEqual(2 * c)
      expect(a.p).toBeGreaterThanOrEqual(0)
      expect(a.p).toBeLessThanOrEqual(c)
      const all = [...a.t1, ...a.t2, ...a.b1, ...a.b2]
      expect(new Set(all).size).toBe(all.length)
    }
  })

  it('a ghost hit in B1 grows the MRU target', () => {
    const a = new Arc<string>(2)
    a.access('a')
    a.access('b')
    a.access('c') // evicts a ghost or block
    const before = a.p
    const ghost = a.b1[0] ?? 'a'
    a.access(ghost)
    expect(a.p).toBeGreaterThanOrEqual(before)
  })

  it('resists a one-time scan far better than LRU', () => {
    const c = 8
    const arc = new Arc<string>(c)
    const lru = new Lru<string>(c)
    const hot = ['h0', 'h1', 'h2', 'h3', 'h4']
    const both = (k: string) => {
      arc.access(k)
      lru.access(k)
    }
    for (let r = 0; r < 6; r++) hot.forEach(both)
    // A backup job reads 40 cold blocks once each, interleaved with the hot set.
    for (let i = 0; i < 40; i++) {
      both(`scan${i}`)
      if (i % 4 === 0) both(hot[(i / 4) % hot.length])
    }
    arc.hits = arc.misses = lru.hits = lru.misses = 0
    for (let r = 0; r < 3; r++) hot.forEach(both)
    expect(arc.hitRate).toBeGreaterThan(lru.hitRate)
    expect(arc.hitRate).toBeGreaterThan(0.8)
  })
})
