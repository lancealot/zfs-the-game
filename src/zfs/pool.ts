/** Pool topology math: capacity, fault tolerance and health of vdev layouts. */

export type VdevType = 'disk' | 'mirror' | 'raidz1' | 'raidz2' | 'raidz3'

export interface DiskSpec {
  name: string
  sizeTB: number
}

export interface VdevSpec {
  type: VdevType
  disks: DiskSpec[]
}

export type DevState = 'ONLINE' | 'DEGRADED' | 'FAULTED' | 'UNAVAIL' | 'OFFLINE' | 'REMOVED'

export const PARITY: Record<VdevType, number> = { disk: 0, mirror: 0, raidz1: 1, raidz2: 2, raidz3: 3 }

/** Rough random-I/O capability of one spinning disk, used for relative comparisons. */
export const DISK_IOPS = 150

export function minDisks(type: VdevType): number {
  if (type === 'disk') return 1
  if (type === 'mirror') return 2
  return PARITY[type] + 1
}

/** How many member disks a vdev can lose and keep working. */
export function vdevTolerance(v: VdevSpec): number {
  if (v.type === 'disk') return 0
  if (v.type === 'mirror') return v.disks.length - 1
  return PARITY[v.type]
}

export function vdevRawTB(v: VdevSpec) {
  return v.disks.reduce((s, d) => s + d.sizeTB, 0)
}

/** Usable capacity, ignoring metadata, padding and slop space. */
export function vdevUsableTB(v: VdevSpec) {
  if (v.disks.length === 0) return 0
  const smallest = Math.min(...v.disks.map((d) => d.sizeTB))
  if (v.type === 'disk') return v.disks[0].sizeTB
  if (v.type === 'mirror') return smallest
  return smallest * (v.disks.length - PARITY[v.type])
}

export interface PoolStats {
  rawTB: number
  usableTB: number
  /** Failures the pool is guaranteed to survive, wherever they land. */
  tolerance: number
  vdevCount: number
  efficiency: number
  /** Relative random write IOPS: roughly one disk's worth per top-level vdev. */
  writeIops: number
}

export function poolStats(vdevs: VdevSpec[]): PoolStats {
  const rawTB = vdevs.reduce((s, v) => s + vdevRawTB(v), 0)
  const usableTB = vdevs.reduce((s, v) => s + vdevUsableTB(v), 0)
  return {
    rawTB,
    usableTB,
    tolerance: vdevs.length ? Math.min(...vdevs.map(vdevTolerance)) : 0,
    vdevCount: vdevs.length,
    efficiency: rawTB ? usableTB / rawTB : 0,
    writeIops: vdevs.length * DISK_IOPS,
  }
}

export function vdevState(v: VdevSpec, failed: ReadonlySet<string>): DevState {
  const lost = v.disks.filter((d) => failed.has(d.name)).length
  if (lost === 0) return 'ONLINE'
  if (lost <= vdevTolerance(v)) return 'DEGRADED'
  return 'UNAVAIL'
}

/** A pool needs every top-level vdev; losing one takes the whole pool down. */
export function poolState(vdevs: VdevSpec[], failed: ReadonlySet<string>): DevState {
  const states = vdevs.map((v) => vdevState(v, failed))
  if (states.includes('UNAVAIL')) return 'UNAVAIL'
  if (states.includes('DEGRADED')) return 'DEGRADED'
  return 'ONLINE'
}

/** Mirrors zpool's own complaint for an invalid vdev, or null if it's fine. */
export function validateVdev(type: VdevType, count: number): string | null {
  const min = minDisks(type)
  if (count < min) {
    const name = type === 'raidz1' ? 'raidz' : type
    return `invalid vdev specification: ${name} requires at least ${min} devices`
  }
  return null
}

/** zpool refuses to mix redundancy levels without -f; this mimics its message. */
export function replicationMismatch(existing: VdevSpec[], type: VdevType, count: number): string | null {
  if (existing.length === 0) return null
  const prev = existing[0]
  const fam = (t: VdevType) => (t.startsWith('raidz') ? 'raidz' : t)
  const head = 'mismatched replication level:'
  if (fam(prev.type) !== fam(type)) return `${head} pool uses ${fam(prev.type)} and new vdev is ${fam(type)}`
  if (PARITY[prev.type] !== PARITY[type]) return `${head} pool uses ${PARITY[prev.type]} device parity and new vdev uses ${PARITY[type]}`
  if (type !== 'disk' && prev.disks.length !== count)
    return `${head} pool uses ${prev.disks.length}-way ${fam(type)} and new vdev uses ${count}-way ${fam(type)}`
  return null
}

/** zpool names a top-level vdev after its type and its index in the pool, e.g. mirror-1. */
export function vdevNames(vdevs: VdevSpec[]): string[] {
  return vdevs.map((v, i) => (v.type === 'disk' ? v.disks[0].name : `${v.type}-${i}`))
}

/** The `zpool create` command line that would build this layout. */
export function createCommand(pool: string, vdevs: VdevSpec[]): string {
  const parts = vdevs.map((v) => (v.type === 'disk' ? v.disks[0].name : `${v.type} ${v.disks.map((d) => d.name).join(' ')}`))
  return `zpool create ${pool} ${parts.join(' ')}`
}
