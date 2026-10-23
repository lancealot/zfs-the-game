import { describe, it, expect } from 'vitest'
import { poolStats, poolState, vdevState, validateVdev, replicationMismatch, vdevNames, type VdevSpec } from '../src/zfs/pool'
import { formatStatus } from '../src/zfs/status'

const d = (n: string, sizeTB = 4) => ({ name: n, sizeTB })
const mirror = (...n: string[]): VdevSpec => ({ type: 'mirror', disks: n.map((x) => d(x)) })
const raidz = (p: 1 | 2 | 3, ...n: string[]): VdevSpec => ({ type: `raidz${p}`, disks: n.map((x) => d(x)) })

describe('pool math', () => {
  it('raidz2 of eight 4 TB disks: 24 TB usable, survives two', () => {
    const s = poolStats([raidz(2, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h')])
    expect(s.usableTB).toBe(24)
    expect(s.tolerance).toBe(2)
    expect(s.vdevCount).toBe(1)
  })

  it('four mirrors: 16 TB, any single failure, four vdevs of IOPS', () => {
    const s = poolStats([mirror('a', 'b'), mirror('c', 'd'), mirror('e', 'f'), mirror('g', 'h')])
    expect(s.usableTB).toBe(16)
    expect(s.tolerance).toBe(1)
    expect(s.writeIops).toBe(600)
  })

  it('mirror capacity is limited by its smallest disk', () => {
    expect(poolStats([{ type: 'mirror', disks: [d('a', 4), d('b', 2)] }]).usableTB).toBe(2)
  })

  it('losing both halves of one mirror takes down a striped pool', () => {
    const vdevs = [mirror('a', 'b'), mirror('c', 'd')]
    expect(poolState(vdevs, new Set(['a', 'c']))).toBe('DEGRADED')
    expect(poolState(vdevs, new Set(['a', 'b']))).toBe('UNAVAIL')
    expect(vdevState(vdevs[1], new Set(['a', 'b']))).toBe('ONLINE')
  })

  it('validates widths and mixed redundancy like zpool', () => {
    expect(validateVdev('mirror', 1)).toMatch(/requires at least 2/)
    expect(validateVdev('raidz2', 2)).toMatch(/requires at least 3/)
    expect(validateVdev('raidz1', 3)).toBeNull()
    expect(replicationMismatch([mirror('a', 'b')], 'raidz1', 3)).toMatch(/pool uses mirror and new vdev is raidz/)
    expect(replicationMismatch([mirror('a', 'b')], 'mirror', 2)).toBeNull()
    expect(replicationMismatch([mirror('a', 'b')], 'mirror', 3)).toMatch(/2-way mirror/)
  })

  it('names vdevs by type and index', () => {
    expect(vdevNames([mirror('a', 'b'), raidz(2, 'c', 'd', 'e', 'f')])).toEqual(['mirror-0', 'raidz2-1'])
  })
})

describe('zpool status formatting', () => {
  it('lays out columns like the real command', () => {
    const out = formatStatus({
      pool: 'tank',
      state: 'ONLINE',
      vdevs: [{ name: 'mirror-0', state: 'ONLINE', children: [{ name: 'sda', state: 'ONLINE' }, { name: 'sdb', state: 'ONLINE', cksum: 3 }] }],
    })
    const lines = out.split('\n')
    expect(lines[0]).toBe('  pool: tank')
    expect(lines[1]).toBe(' state: ONLINE')
    expect(out).toContain('        NAME        STATE     READ WRITE CKSUM')
    expect(out).toContain('        tank        ONLINE       0     0     0')
    expect(out).toContain('          mirror-0  ONLINE       0     0     0')
    expect(out).toContain('            sdb     ONLINE       0     0     3')
    expect(lines[lines.length - 1]).toBe('errors: No known data errors')
  })
})
