import { describe, it, expect } from 'vitest'
import { CowPool, noiseBytes, textBytes, type DatasetSpec } from '../src/zfs/blocktree'
import { cksumEqual } from '../src/zfs/checksum'

const DS = 'tank/home'
const spec = (): DatasetSpec[] => [
  {
    name: DS,
    files: [
      { name: 'cat.png', blocks: [0, 1, 2, 3].map((i) => noiseBytes(i)) },
      { name: 'notes.txt', blocks: [textBytes('hello')], compressible: true },
    ],
  },
]

const newPool = () => new CowPool(spec(), { slots: 48, txg: 100 })

describe('CowPool', () => {
  it('builds a Merkle tree: parents carry their children checksums', () => {
    const p = newPool()
    const path = p.pathTo(DS, 'cat.png', 2)
    expect(path.map((b) => b.kind)).toEqual(['mos', 'objset', 'dnode', 'indirect', 'data'])
    for (let i = 0; i < path.length - 1; i++) expect(path[i].children).toContain(path[i + 1])
    expect(p.fileRoot(DS, 'notes.txt').kind).toBe('data')
    expect(p.txg).toBe(100)
  })

  it('copy-on-write: a change rewrites the path to the root in new places', () => {
    const p = newPool()
    const before = p.pathTo(DS, 'cat.png', 1)
    const beforeSlots = before.map((b) => b.slot)
    p.stageWrite(DS, 'cat.png', 1, noiseBytes(99))
    const res = p.sync()!
    expect(res.txg).toBe(101)
    const after = p.pathTo(DS, 'cat.png', 1)
    for (let i = 0; i < after.length; i++) {
      expect(after[i]).not.toBe(before[i])
      expect(beforeSlots).not.toContain(after[i].slot)
      expect(cksumEqual(after[i].cksum, before[i].cksum)).toBe(false)
      expect(after[i].birth).toBe(101)
    }
    // Siblings are shared, not copied.
    expect(p.fileBlocks(DS, 'cat.png')[0]).toBe(before[3].children[0])
    // Every replaced block was freed (no snapshots), so space usage is unchanged.
    expect(res.freed.length).toBe(res.written.length)
    expect(res.written.map((b) => b.kind)).toEqual(['data', 'indirect', 'dnode', 'objset', 'mos'])
  })

  it('batches many changes in one txg into a single tree update', () => {
    const p = newPool()
    for (let i = 0; i < 4; i++) p.stageWrite(DS, 'cat.png', i, noiseBytes(50 + i))
    const res = p.sync()!
    // 4 data blocks + one each of L1, dnode, objset, MOS.
    expect(res.written.length).toBe(8)
  })

  it('a crash before the uberblock lands leaves the old tree intact', () => {
    const p = newPool()
    const oldData = p.fileBlocks(DS, 'cat.png')[0].data
    p.stageWrite(DS, 'cat.png', 0, noiseBytes(7))
    const plan = p.beginSync()!
    expect(plan.written.length).toBeGreaterThan(0)
    const used = p.usedSlots()
    const { uber, orphans } = p.importPool()
    expect(uber.txg).toBe(100)
    expect(orphans.length).toBe(plan.written.length)
    expect(p.usedSlots()).toBe(used - plan.written.length)
    expect(p.fileBlocks(DS, 'cat.png')[0].data).toEqual(oldData)
  })

  it('import skips a torn uberblock and uses the previous one', () => {
    const p = newPool()
    p.stageWrite(DS, 'cat.png', 0, noiseBytes(8))
    const plan = p.beginSync()!
    p.tearUberblock(plan)
    expect(p.importPool().uber.txg).toBe(100)
  })

  it('verify catches corruption and repair heals it', () => {
    const p = newPool()
    const b = p.fileBlocks(DS, 'cat.png')[2]
    expect(p.verify(b)).toBe(true)
    p.corrupt(b.slot)
    expect(p.verify(b)).toBe(false)
    p.repair(b)
    expect(p.verify(b)).toBe(true)
  })

  it('snapshots keep old blocks; the birth txg rule matches reachability', () => {
    const p = newPool()
    p.snapshot(DS, 'monday')
    p.sync()
    const snap = p.latestSnapshot(DS)!
    expect(snap.txg).toBe(101)

    // First change after the snapshot: old blocks (born 100 <= 101) are deadlisted.
    p.stageWrite(DS, 'cat.png', 0, noiseBytes(11))
    const r1 = p.sync()!
    for (const [old] of r1.replaced) {
      if (old.kind === 'mos') continue
      expect(old.birth <= snap.txg).toBe(true)
      expect(r1.deadlisted).toContain(old)
    }

    // Second change: the block born at 102 isn't in any snapshot, so it's freed.
    const born102 = p.fileBlocks(DS, 'cat.png')[0]
    expect(born102.birth).toBe(102)
    p.stageWrite(DS, 'cat.png', 0, noiseBytes(12))
    const r2 = p.sync()!
    expect(born102.birth > snap.txg).toBe(true)
    expect(r2.freed).toContain(born102)
    expect(p.uniqueTo(snap).some((b) => b.kind === 'data')).toBe(true)
  })

  it('rollback restores snapshot contents and frees newer blocks', () => {
    const p = newPool()
    const original = p.fileBlocks(DS, 'cat.png').map((b) => b.data)
    p.snapshot(DS, 'monday')
    p.sync()
    for (let i = 0; i < 4; i++) p.stageWrite(DS, 'cat.png', i, noiseBytes(200 + i))
    p.sync()
    const used = p.usedSlots()
    p.rollback(DS, 'monday')
    const r = p.sync()!
    expect(p.fileBlocks(DS, 'cat.png').map((b) => b.data)).toEqual(original)
    expect(r.freed.every((b) => b.birth > 101 || b.kind === 'mos')).toBe(true)
    expect(p.usedSlots()).toBeLessThan(used)
  })

  it('clones share blocks until they diverge', () => {
    const p = newPool()
    p.snapshot(DS, 'base')
    p.sync()
    p.clone('base', 'tank/test')
    p.sync()
    expect(p.dataset('tank/test')).toBe(p.dataset(DS))
    p.stageWrite('tank/test', 'notes.txt', 0, textBytes('changed'))
    p.sync()
    expect(p.fileBlocks('tank/test', 'notes.txt')[0]).not.toBe(p.fileBlocks(DS, 'notes.txt')[0])
    expect(p.fileBlocks('tank/test', 'cat.png')[0]).toBe(p.fileBlocks(DS, 'cat.png')[0])
  })
})

describe('deleteFile', () => {
  it('frees blocks born after the last snapshot, deadlists older ones', () => {
    const p = newPool()
    p.snapshot(DS, 's1')
    p.sync()
    p.stageWrite(DS, 'cat.png', 3, noiseBytes(77))
    p.sync()
    const blocks = p.fileBlocks(DS, 'cat.png')
    p.deleteFile(DS, 'cat.png')
    const r = p.sync()!
    expect(p.fileNames(DS)).toEqual(['notes.txt'])
    const snapTxg = p.latestSnapshot(DS)!.txg
    for (const b of blocks) {
      if (b.birth > snapTxg) expect(r.freed).toContain(b)
      else expect(r.deadlisted).toContain(b)
    }
  })
})

describe('open txg during a sync', () => {
  it('changes made while a txg syncs join the next txg', () => {
    const p = newPool()
    p.stageWrite(DS, 'cat.png', 0, noiseBytes(1))
    const plan = p.beginSync()!
    expect(p.openTxg).toBe(102)
    p.stageWrite(DS, 'cat.png', 1, noiseBytes(2))
    expect(p.contents(DS, 'cat.png', 0)).toEqual(noiseBytes(1))
    p.commitSync(plan)
    expect(p.dirtyCount()).toBe(1)
    const r = p.sync()!
    expect(r.txg).toBe(102)
    expect(p.fileBlocks(DS, 'cat.png')[1].data).toEqual(noiseBytes(2))
  })

  it('a crash loses both the syncing txg and the open one', () => {
    const p = newPool()
    p.stageWrite(DS, 'cat.png', 0, noiseBytes(1))
    p.beginSync()
    p.stageWrite(DS, 'cat.png', 1, noiseBytes(2))
    p.importPool()
    expect(p.dirtyCount()).toBe(0)
    expect(p.syncing).toBe(null)
    expect(p.txg).toBe(100)
  })
})
