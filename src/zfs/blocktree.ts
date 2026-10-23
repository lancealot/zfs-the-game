/**
 * A miniature copy-on-write pool: a real Merkle tree of blocks (every
 * parent's bytes contain each child's fletcher4 checksum), physical slot
 * allocation, transaction groups, an uberblock ring, snapshots, clones and
 * rollback. Small enough to animate block by block.
 *
 * Simplifications: one top-level vdev, one slot per block regardless of
 * size, and the MOS points straight at each dataset's object set.
 */
import { fletcher4, cksumEqual, type Cksum } from './checksum'

export type Kind = 'mos' | 'objset' | 'dnode' | 'indirect' | 'data'

export interface BlkMeta {
  label: string
  dataset?: string
  file?: string
  index?: number
  level: number
}

export interface Blk {
  readonly id: number
  readonly kind: Kind
  readonly birth: number
  readonly data: Uint8Array
  readonly children: readonly Blk[]
  readonly cksum: Cksum
  readonly slot: number
  readonly lsize: number
  readonly psize: number
  readonly comp: 'lz4' | 'off'
  readonly meta: BlkMeta
}

export interface FileSpec {
  name: string
  blocks: Uint8Array[]
  /** Text-like data compresses; already-compressed media doesn't. */
  compressible?: boolean
  /** Txg the file was written in; defaults to the pool's starting txg. */
  birth?: number
}

export interface DatasetSpec {
  name: string
  files: FileSpec[]
}

export interface Uber {
  txg: number
  root: Blk
  timestamp: number
  /** A torn uberblock write fails its own checksum and is skipped on import. */
  valid: boolean
}

export interface Snapshot {
  name: string
  dataset: string
  txg: number
  root: Blk
}

export interface SyncPlan {
  txg: number
  /** The changes this sync is writing, moved out of the open txg. */
  dirty: Map<string, Map<string, Map<number, Uint8Array>>>
  written: Blk[]
  replaced: Map<Blk, Blk>
  datasets: Map<string, Blk>
  snapshots: Snapshot[]
  mos: Blk
}

export interface SyncResult {
  txg: number
  written: Blk[]
  replaced: Map<Blk, Blk>
  /** Blocks nothing references any more; their slots are free again. */
  freed: Blk[]
  /** Blocks the live data dropped but a snapshot still holds. */
  deadlisted: Blk[]
  uber: Uber
}

export const RING = 8
export const BLOCK_BYTES = 64
const enc = new TextEncoder()

/** Offsets and sizes printed in DVAs and zdb lines. */
export const SLOT_BYTES = 0x20000

export class CowPool {
  readonly slots: Array<Blk | null>
  /** What is physically on each slot right now. Normally equal to the block's data. */
  readonly media: Array<Uint8Array | null>
  readonly ring: Array<Uber | null> = new Array(RING).fill(null)
  uber!: Uber
  datasets = new Map<string, Blk>()
  snapshots: Snapshot[] = []

  private dirty = new Map<string, Map<string, Map<number, Uint8Array>>>()
  private deletes = new Map<string, Set<string>>()
  private pending: Array<
    | { op: 'snapshot'; dataset: string; name: string }
    | { op: 'rollback'; dataset: string; snap: string }
    | { op: 'clone'; snap: string; dataset: string }
    | { op: 'destroy'; snap: string }
  > = []
  private inflight: SyncPlan | null = null
  private nextId = 1
  private cursor = 0
  private clock = 1_700_000_000

  constructor(specs: DatasetSpec[], opts: { slots: number; txg: number }) {
    this.slots = new Array(opts.slots).fill(null)
    this.media = new Array(opts.slots).fill(null)
    const txg = opts.txg
    for (const ds of specs) {
      const fileRoots = ds.files.map((f) => {
        const birth = f.birth ?? txg
        const datas = f.blocks.map((bytes, i) =>
          this.write('data', bytes, [], birth, { label: 'L0', dataset: ds.name, file: f.name, index: i, level: 0 }, f.compressible),
        )
        if (datas.length === 1) return datas[0]
        return this.write('indirect', ptrBytes('L1', datas), datas, birth, { label: 'L1', dataset: ds.name, file: f.name, level: 1 })
      })
      const birth = Math.max(txg, ...fileRoots.map((b) => b.birth))
      const dn = this.write('dnode', dnodeBytes(ds.files.map((f) => f.name), fileRoots), fileRoots, birth, {
        label: 'dnodes',
        dataset: ds.name,
        level: 0,
      })
      const os = this.write('objset', ptrBytes(ds.name, [dn]), [dn], birth, { label: 'objset', dataset: ds.name, level: 0 })
      this.datasets.set(ds.name, os)
    }
    const top = Math.max(txg, ...[...this.datasets.values()].map((b) => b.birth))
    const mos = this.write('mos', this.mosBytes(this.datasets, []), [...this.datasets.values()], top, { label: 'MOS', level: 0 })
    this.uber = { txg: top, root: mos, timestamp: this.clock, valid: true }
    this.ring[top % RING] = this.uber
  }

  get txg() {
    return this.uber.txg
  }

  /** The txg that new changes join. While one is syncing, that's the one after it. */
  get openTxg() {
    return this.uber.txg + (this.inflight ? 2 : 1)
  }

  get syncing(): SyncPlan | null {
    return this.inflight
  }

  get mos() {
    return this.uber.root
  }

  // --------------------------------------------------------------- reads

  dataset(name: string) {
    const b = this.datasets.get(name)
    if (!b) throw new Error(`no dataset ${name}`)
    return b
  }

  dnodeBlock(dataset: string) {
    return this.dataset(dataset).children[0]
  }

  fileNames(dataset: string): string[] {
    return this.dnodeBlock(dataset).children.map((b) => b.meta.file!)
  }

  /** Root block of a file: its single L0, or its L1 indirect block. */
  fileRoot(dataset: string, file: string, root: Blk = this.dataset(dataset)) {
    const r = root.children[0].children.find((b) => b.meta.file === file)
    if (!r) throw new Error(`no file ${file}`)
    return r
  }

  fileBlocks(dataset: string, file: string, root?: Blk): Blk[] {
    const r = this.fileRoot(dataset, file, root)
    return r.kind === 'data' ? [r] : [...r.children]
  }

  /** Blocks from the MOS down to one data block. */
  pathTo(dataset: string, file: string, index: number, root?: Blk): Blk[] {
    const os = root ?? this.dataset(dataset)
    const dn = os.children[0]
    const fr = this.fileRoot(dataset, file, os)
    const leaf = fr.kind === 'data' ? fr : fr.children[index]
    return fr.kind === 'data' ? [this.mos, os, dn, leaf] : [this.mos, os, dn, fr, leaf]
  }

  parentOf(target: Blk, root: Blk = this.mos): Blk | null {
    const stack: Blk[] = [root]
    const seen = new Set<Blk>()
    while (stack.length) {
      const b = stack.pop()!
      if (seen.has(b)) continue
      seen.add(b)
      for (const c of b.children) {
        if (c === target) return b
        stack.push(c)
      }
    }
    return null
  }

  /** Does the copy on disk still match the checksum its parent holds? */
  verify(b: Blk): boolean {
    const m = this.media[b.slot]
    return !!m && cksumEqual(fletcher4(m), b.cksum)
  }

  reachable(roots: Blk[]): Set<Blk> {
    const out = new Set<Blk>()
    const stack = [...roots]
    while (stack.length) {
      const b = stack.pop()!
      if (out.has(b)) continue
      out.add(b)
      stack.push(...b.children)
    }
    return out
  }

  /** Space held by each snapshot alone (blocks no other root references). */
  uniqueTo(snap: Snapshot): Blk[] {
    const others = [...this.datasets.values(), ...this.snapshots.filter((s) => s !== snap).map((s) => s.root)]
    const elsewhere = this.reachable(others)
    return [...this.reachable([snap.root])].filter((b) => !elsewhere.has(b))
  }

  latestSnapshot(dataset: string): Snapshot | undefined {
    const s = this.snapshots.filter((x) => x.dataset === dataset)
    return s[s.length - 1]
  }

  usedSlots() {
    return this.slots.filter(Boolean).length
  }

  // ----------------------------------------------------------- mutations

  stageWrite(dataset: string, file: string, index: number, bytes: Uint8Array) {
    let ds = this.dirty.get(dataset)
    if (!ds) this.dirty.set(dataset, (ds = new Map()))
    let f = ds.get(file)
    if (!f) ds.set(file, (f = new Map()))
    f.set(index, bytes)
  }

  /** The newest contents of a block, including changes not yet synced. */
  contents(dataset: string, file: string, index: number): Uint8Array {
    const staged = this.dirty.get(dataset)?.get(file)?.get(index) ?? this.inflight?.dirty.get(dataset)?.get(file)?.get(index)
    if (staged) return staged
    return this.fileBlocks(dataset, file)[index].data
  }

  dirtyCount() {
    let n = 0
    for (const ds of this.dirty.values()) for (const f of ds.values()) n += f.size
    for (const d of this.deletes.values()) n += d.size
    return n + this.pending.length
  }

  /** Removes a file from the dataset in the open txg. */
  deleteFile(dataset: string, file: string) {
    let set = this.deletes.get(dataset)
    if (!set) this.deletes.set(dataset, (set = new Set()))
    set.add(file)
    this.dirty.get(dataset)?.delete(file)
  }

  snapshot(dataset: string, name: string) {
    this.pending.push({ op: 'snapshot', dataset, name })
  }

  rollback(dataset: string, snap: string) {
    this.dirty.delete(dataset)
    this.deletes.delete(dataset)
    this.pending.push({ op: 'rollback', dataset, snap })
  }

  clone(snap: string, dataset: string) {
    this.pending.push({ op: 'clone', snap, dataset })
  }

  destroySnapshot(snap: string) {
    this.pending.push({ op: 'destroy', snap })
  }

  /** Throws away everything in RAM, as a power cut would. */
  dropDirty() {
    this.dirty.clear()
    this.deletes.clear()
    this.pending = []
    this.inflight = null
  }

  /** Damages the on-disk copy in a slot (bit rot). */
  corrupt(slot: number, flips = 3) {
    const m = this.media[slot]
    if (!m) return
    const copy = new Uint8Array(m)
    for (let i = 0; i < flips; i++) copy[(i * 23 + 7) % copy.length] ^= 1 << (i % 8)
    this.media[slot] = copy
  }

  /** Rewrites a slot with the correct data (self-healing). */
  repair(b: Blk) {
    this.media[b.slot] = new Uint8Array(b.data)
  }

  /**
   * Writes every new block for the open txg to free space, bottom-up, but
   * doesn't commit. Until `commitSync`, the old tree is still the real one.
   */
  beginSync(): SyncPlan | null {
    if (this.inflight) throw new Error('a txg is already syncing')
    if (this.dirtyCount() === 0) return null
    const txg = this.openTxg
    const dirtyNow = this.dirty
    const deletesNow = this.deletes
    const pendingNow = this.pending
    this.dirty = new Map()
    this.deletes = new Map()
    this.pending = []
    const written: Blk[] = []
    const replaced = new Map<Blk, Blk>()
    const datasets = new Map(this.datasets)
    let snapshots = [...this.snapshots]

    const w = (kind: Kind, data: Uint8Array, children: Blk[], meta: BlkMeta, compressible?: boolean, old?: Blk) => {
      const b = this.write(kind, data, children, txg, meta, compressible)
      written.push(b)
      if (old) replaced.set(old, b)
      return b
    }

    const touched = new Set([...dirtyNow.keys(), ...deletesNow.keys()])
    for (const dsName of touched) {
      const files = dirtyNow.get(dsName) ?? new Map<string, Map<number, Uint8Array>>()
      const gone = deletesNow.get(dsName) ?? new Set<string>()
      const os = datasets.get(dsName)!
      const dn = os.children[0]
      const kept = dn.children.filter((b) => !gone.has(b.meta.file!))
      const names = kept.map((b) => b.meta.file!)
      // Rewritten blocks belong to the dataset being written, even if they started out shared with a clone origin.
      const m = (b: Blk): BlkMeta => ({ ...b.meta, dataset: dsName })
      const roots = kept.map((fr) => {
        const changes = files.get(fr.meta.file!)
        if (!changes) return fr
        if (fr.kind === 'data') {
          return w('data', changes.get(0) ?? fr.data, [], m(fr), fr.comp === 'lz4', fr)
        }
        const kids = fr.children.map((d, i) => (changes.has(i) ? w('data', changes.get(i)!, [], m(d), d.comp === 'lz4', d) : d))
        return w('indirect', ptrBytes('L1', kids), kids, m(fr), undefined, fr)
      })
      const ndn = w('dnode', dnodeBytes(names, roots), roots, m(dn), undefined, dn)
      const nos = w('objset', ptrBytes(dsName, [ndn]), [ndn], m(os), undefined, os)
      datasets.set(dsName, nos)
    }

    for (const p of pendingNow) {
      if (p.op === 'snapshot') {
        snapshots.push({ name: p.name, dataset: p.dataset, txg, root: datasets.get(p.dataset)! })
      } else if (p.op === 'rollback') {
        const s = snapshots.find((x) => x.name === p.snap)
        if (!s) throw new Error(`no snapshot ${p.snap}`)
        datasets.set(p.dataset, s.root)
        // Rolling back past newer snapshots destroys them (zfs rollback -r).
        snapshots = snapshots.filter((x) => x.dataset !== p.dataset || x.txg <= s.txg)
      } else if (p.op === 'clone') {
        const s = snapshots.find((x) => x.name === p.snap)
        if (!s) throw new Error(`no snapshot ${p.snap}`)
        datasets.set(p.dataset, s.root)
      } else if (p.op === 'destroy') {
        snapshots = snapshots.filter((x) => x.name !== p.snap)
      }
    }

    const mos = w('mos', this.mosBytes(datasets, snapshots), uniq([...datasets.values(), ...snapshots.map((s) => s.root)]), { label: 'MOS', level: 0 }, undefined, this.mos)
    const plan: SyncPlan = { txg, dirty: dirtyNow, written, replaced, datasets, snapshots, mos }
    this.inflight = plan
    return plan
  }

  /** Writes the new uberblock: the moment the txg becomes permanent. */
  commitSync(plan: SyncPlan): SyncResult {
    const liveBefore = this.reachable([...this.datasets.values()])
    this.clock += 5
    const uber: Uber = { txg: plan.txg, root: plan.mos, timestamp: this.clock, valid: true }
    this.ring[plan.txg % RING] = uber
    this.uber = uber
    this.datasets = plan.datasets
    this.snapshots = plan.snapshots
    this.inflight = null

    const live = this.reachable([...this.datasets.values()])
    const all = this.reachable([this.mos])
    const freed: Blk[] = []
    const deadlisted: Blk[] = []
    for (const b of this.slots) {
      if (!b) continue
      if (!all.has(b)) freed.push(b)
      else if (liveBefore.has(b) && !live.has(b)) deadlisted.push(b)
    }
    for (const b of freed) this.release(b)
    return { txg: plan.txg, written: plan.written, replaced: plan.replaced, freed, deadlisted, uber }
  }

  sync(): SyncResult | null {
    const plan = this.beginSync()
    return plan ? this.commitSync(plan) : null
  }

  /**
   * Power returns: pick the newest valid uberblock and treat everything it
   * can't reach as free space. Uncommitted changes are gone.
   */
  importPool(): { uber: Uber; orphans: Blk[] } {
    this.dropDirty()
    const best = this.ring.filter((u): u is Uber => !!u && u.valid).sort((a, b) => b.txg - a.txg)[0]
    this.uber = best
    const reach = this.reachable([best.root])
    const orphans = this.slots.filter((b): b is Blk => !!b && !reach.has(b))
    for (const b of orphans) this.release(b)
    return { uber: best, orphans }
  }

  /** Simulates a torn write of the next uberblock slot. */
  tearUberblock(plan: SyncPlan) {
    this.ring[plan.txg % RING] = { txg: plan.txg, root: plan.mos, timestamp: this.clock + 5, valid: false }
  }

  /** Datasets and snapshots as they would be after an incoming plan commits. */
  rootsOf(plan: SyncPlan | null) {
    return plan ? { datasets: plan.datasets, snapshots: plan.snapshots } : { datasets: this.datasets, snapshots: this.snapshots }
  }

  // ------------------------------------------------------------ internals

  private alloc(): number {
    const n = this.slots.length
    for (let k = 0; k < n; k++) {
      const i = (this.cursor + k) % n
      if (!this.slots[i]) {
        this.cursor = (i + 1) % n
        return i
      }
    }
    throw new Error('pool is full')
  }

  private release(b: Blk) {
    if (this.slots[b.slot] === b) {
      this.slots[b.slot] = null
      this.media[b.slot] = null
    }
  }

  private write(kind: Kind, data: Uint8Array, children: readonly Blk[], birth: number, meta: BlkMeta, compressible?: boolean): Blk {
    const slot = this.alloc()
    const { lsize, psize, comp } = sizes(kind, compressible)
    const b: Blk = {
      id: this.nextId++,
      kind,
      birth,
      data: new Uint8Array(data),
      children: [...children],
      cksum: fletcher4(data),
      slot,
      lsize,
      psize,
      comp,
      meta,
    }
    this.slots[slot] = b
    this.media[slot] = new Uint8Array(data)
    return b
  }

  private mosBytes(datasets: Map<string, Blk>, snapshots: Snapshot[]) {
    const names = [...datasets.keys(), ...snapshots.map((s) => `${s.dataset}@${s.name}`)]
    return ptrBytes(names.join(','), uniq([...datasets.values(), ...snapshots.map((s) => s.root)]))
  }
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)]
}

function sizes(kind: Kind, compressible?: boolean): { lsize: number; psize: number; comp: 'lz4' | 'off' } {
  switch (kind) {
    case 'data':
      return compressible ? { lsize: 0x20000, psize: 0x6000, comp: 'lz4' } : { lsize: 0x20000, psize: 0x20000, comp: 'off' }
    case 'indirect':
      return { lsize: 0x20000, psize: 0x1000, comp: 'lz4' }
    case 'dnode':
      return { lsize: 0x4000, psize: 0x800, comp: 'lz4' }
    default:
      return { lsize: 0x1000, psize: 0x400, comp: 'lz4' }
  }
}

/** A block of block pointers: each child's slot, birth and full checksum. */
export function ptrBytes(tag: string, children: readonly Blk[]): Uint8Array {
  const head = enc.encode(tag.padEnd(16, '\0').slice(0, 16))
  const out = new Uint8Array(16 + children.length * 40)
  out.set(head, 0)
  const v = new DataView(out.buffer)
  children.forEach((c, i) => {
    const o = 16 + i * 40
    v.setUint32(o, c.slot, true)
    v.setUint32(o + 4, c.birth, true)
    c.cksum.forEach((w, j) => v.setBigUint64(o + 8 + j * 8, w, true))
  })
  return out
}

function dnodeBytes(names: string[], roots: readonly Blk[]) {
  return ptrBytes(names.join('|'), roots)
}

/** zdb's description of a block's type and level. */
export function zdbType(b: Blk): string {
  switch (b.kind) {
    case 'data':
      return 'L0 ZFS plain file'
    case 'indirect':
      return 'L1 ZFS plain file'
    case 'dnode':
      return 'L0 DMU dnode'
    default:
      return 'L0 DMU objset'
  }
}

/** Number of copies ZFS keeps by default: pool metadata 3, dataset metadata 2, data 1. */
export function copiesOf(b: Blk) {
  return b.kind === 'mos' ? 3 : b.kind === 'data' ? 1 : 2
}

export function dvaText(b: Blk, copy = 0) {
  const asize = Math.max(0x1000, Math.ceil(b.psize / 0x1000) * 0x1000)
  // Ditto copies are placed far from the first, as ZFS does on a single disk.
  const offset = b.slot * SLOT_BYTES + copy * 0x1f40000
  return `<0:${offset.toString(16)}:${asize.toString(16)}>`
}

export function zdbLine(b: Blk, cksumText: string) {
  const copies = copiesOf(b)
  const dvas = Array.from({ length: copies }, (_, i) => `DVA[${i}]=${dvaText(b, i)}`).join(' ')
  const fill = b.kind === 'data' ? 1 : b.children.length
  return `${dvas} [${zdbType(b)}] fletcher4 ${b.comp === 'lz4' ? 'lz4' : 'uncompressed'} LE contiguous unique ${['single', 'double', 'triple'][copies - 1]} size=${b.lsize.toString(16)}L/${b.psize.toString(16)}P birth=${b.birth}L/${b.birth}P fill=${fill} cksum=${cksumText}`
}

/** Deterministic filler bytes for blocks that aren't pictures or text. */
export function noiseBytes(seed: number, n = BLOCK_BYTES) {
  const out = new Uint8Array(n)
  let x = seed * 2654435761 + 1
  for (let i = 0; i < n; i++) {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    out[i] = x & 0xff
  }
  return out
}

export function textBytes(s: string, n = BLOCK_BYTES) {
  const out = new Uint8Array(n)
  out.set(enc.encode(s).slice(0, n))
  return out
}
