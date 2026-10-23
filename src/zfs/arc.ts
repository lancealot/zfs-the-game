/**
 * Adaptive Replacement Cache (Megiddo & Modha, 2003), the algorithm the ZFS
 * ARC is built on. Lists are kept most-recent-first.
 *
 *   T1: cached, seen once recently (MRU)     B1: ghosts evicted from T1
 *   T2: cached, seen at least twice (MFU)    B2: ghosts evicted from T2
 *   p : target size of T1, adapted on ghost hits
 *
 * ZFS adds variable block sizes, memory pressure and more, but the
 * MRU/MFU/ghost mechanics are the same.
 */

export type ArcList = 'T1' | 'T2' | 'B1' | 'B2'

export interface ArcMove<K> {
  key: K
  from: ArcList | null
  to: ArcList | null
}

export interface ArcResult<K> {
  key: K
  hit: boolean
  /** Where the key was found before this access, if anywhere. */
  found: ArcList | null
  moves: ArcMove<K>[]
  p: number
}

export class Arc<K> {
  t1: K[] = []
  t2: K[] = []
  b1: K[] = []
  b2: K[] = []
  p = 0
  hits = 0
  misses = 0

  constructor(readonly c: number) {}

  where(key: K): ArcList | null {
    if (this.t1.includes(key)) return 'T1'
    if (this.t2.includes(key)) return 'T2'
    if (this.b1.includes(key)) return 'B1'
    if (this.b2.includes(key)) return 'B2'
    return null
  }

  access(key: K): ArcResult<K> {
    const moves: ArcMove<K>[] = []
    const found = this.where(key)
    const c = this.c

    if (found === 'T1' || found === 'T2') {
      // Case I: a real hit. Promote to the MFU side.
      this.hits++
      this.remove(found, key)
      this.t2.unshift(key)
      moves.push({ key, from: found, to: 'T2' })
      return { key, hit: true, found, moves, p: this.p }
    }

    this.misses++
    if (found === 'B1') {
      // Case II: we evicted a recent block too soon. Grow the MRU target.
      const delta = Math.max(this.b2.length / this.b1.length, 1)
      this.p = Math.min(c, this.p + delta)
      this.replace(key, moves)
      this.remove('B1', key)
      this.t2.unshift(key)
      moves.push({ key, from: 'B1', to: 'T2' })
    } else if (found === 'B2') {
      // Case III: a frequent block was evicted too soon. Grow the MFU side.
      const delta = Math.max(this.b1.length / this.b2.length, 1)
      this.p = Math.max(0, this.p - delta)
      this.replace(key, moves)
      this.remove('B2', key)
      this.t2.unshift(key)
      moves.push({ key, from: 'B2', to: 'T2' })
    } else {
      // Case IV: a brand-new block.
      const l1 = this.t1.length + this.b1.length
      const total = l1 + this.t2.length + this.b2.length
      if (l1 === c) {
        if (this.t1.length < c) {
          const g = this.b1.pop()!
          moves.push({ key: g, from: 'B1', to: null })
          this.replace(key, moves)
        } else {
          const v = this.t1.pop()!
          moves.push({ key: v, from: 'T1', to: null })
        }
      } else if (l1 < c && total >= c) {
        if (total === 2 * c) {
          const g = this.b2.pop()!
          moves.push({ key: g, from: 'B2', to: null })
        }
        this.replace(key, moves)
      }
      this.t1.unshift(key)
      moves.push({ key, from: null, to: 'T1' })
    }
    return { key, hit: false, found, moves, p: this.p }
  }

  private replace(key: K, moves: ArcMove<K>[]) {
    const inB2 = this.b2.includes(key)
    if (this.t1.length >= 1 && ((inB2 && this.t1.length === this.p) || this.t1.length > this.p)) {
      const v = this.t1.pop()!
      this.b1.unshift(v)
      moves.push({ key: v, from: 'T1', to: 'B1' })
    } else if (this.t2.length > 0) {
      const v = this.t2.pop()!
      this.b2.unshift(v)
      moves.push({ key: v, from: 'T2', to: 'B2' })
    } else if (this.t1.length > 0) {
      const v = this.t1.pop()!
      this.b1.unshift(v)
      moves.push({ key: v, from: 'T1', to: 'B1' })
    }
  }

  private remove(list: ArcList, key: K) {
    const arr = this.list(list)
    const i = arr.indexOf(key)
    if (i >= 0) arr.splice(i, 1)
  }

  list(l: ArcList): K[] {
    return l === 'T1' ? this.t1 : l === 'T2' ? this.t2 : l === 'B1' ? this.b1 : this.b2
  }

  get hitRate() {
    const n = this.hits + this.misses
    return n ? this.hits / n : 0
  }
}

/** Plain least-recently-used cache, for comparison. */
export class Lru<K> {
  items: K[] = []
  hits = 0
  misses = 0

  constructor(readonly c: number) {}

  access(key: K): { hit: boolean; evicted: K | null } {
    const i = this.items.indexOf(key)
    if (i >= 0) {
      this.hits++
      this.items.splice(i, 1)
      this.items.unshift(key)
      return { hit: true, evicted: null }
    }
    this.misses++
    this.items.unshift(key)
    const evicted = this.items.length > this.c ? this.items.pop()! : null
    return { hit: false, evicted }
  }

  get hitRate() {
    const n = this.hits + this.misses
    return n ? this.hits / n : 0
  }
}
