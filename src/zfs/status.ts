/** Formats `zpool status` output the way the real command lays it out. */

export interface StatusDev {
  name: string
  state: string
  read?: number
  write?: number
  cksum?: number
  /** Trailing note, e.g. "cannot open" or "(repairing)". */
  note?: string
  children?: StatusDev[]
  /** Spares show no error counters. */
  noCounters?: boolean
}

export interface StatusModel {
  pool: string
  state: string
  status?: string
  action?: string
  see?: string
  scan?: string
  vdevs: StatusDev[]
  logs?: StatusDev[]
  cache?: StatusDev[]
  spares?: StatusDev[]
  errors?: string
  /** Counters for the pool's own row. */
  poolCounters?: { read: number; write: number; cksum: number }
}

const IND = '        '

function wrapField(key: string, value: string) {
  const lines = value.split('\n')
  return [`${key.padStart(6)}: ${lines[0]}`, ...lines.slice(1).map((l) => `${IND}${l}`)]
}

export function formatStatus(m: StatusModel): string {
  const out: string[] = []
  out.push(...wrapField('pool', m.pool))
  out.push(...wrapField('state', m.state))
  if (m.status) out.push(...wrapField('status', m.status))
  if (m.action) out.push(...wrapField('action', m.action))
  if (m.see) out.push(...wrapField('see', m.see))
  out.push(...wrapField('scan', m.scan ?? 'none requested'))
  out.push('config:', '')

  const rows: Array<{ depth: number; dev: StatusDev }> = []
  const walk = (d: StatusDev, depth: number) => {
    rows.push({ depth, dev: d })
    for (const c of d.children ?? []) walk(c, depth + 2)
  }
  const poolRow: StatusDev = { name: m.pool, state: m.state, ...(m.poolCounters ?? {}) }
  rows.push({ depth: 0, dev: poolRow })
  for (const v of m.vdevs) walk(v, 2)
  const sections: Array<[string, StatusDev[] | undefined]> = [
    ['logs', m.logs],
    ['cache', m.cache],
    ['spares', m.spares],
  ]
  const sectionRows: Array<{ title: string; rows: Array<{ depth: number; dev: StatusDev }> }> = []
  for (const [title, devs] of sections) {
    if (!devs?.length) continue
    const r: Array<{ depth: number; dev: StatusDev }> = []
    const w = (d: StatusDev, depth: number) => {
      r.push({ depth, dev: d })
      for (const c of d.children ?? []) w(c, depth + 2)
    }
    for (const d of devs) w(d, 2)
    sectionRows.push({ title, rows: r })
  }
  const all = [...rows, ...sectionRows.flatMap((s) => s.rows)]
  const nameWidth = Math.max(10, ...all.map((r) => r.depth + r.dev.name.length))

  const fmtRow = (depth: number, d: StatusDev) => {
    const name = ' '.repeat(depth) + d.name.padEnd(nameWidth - depth)
    let line = `${IND}${name}  ${d.state.padEnd(8)}`
    if (!d.noCounters) {
      line += ` ${String(d.read ?? 0).padStart(5)} ${String(d.write ?? 0).padStart(5)} ${String(d.cksum ?? 0).padStart(5)}`
    }
    if (d.note) line += `  ${d.note}`
    return line.replace(/\s+$/, '')
  }

  out.push(`${IND}${'NAME'.padEnd(nameWidth)}  ${'STATE'.padEnd(8)} ${'READ'.padStart(5)} ${'WRITE'.padStart(5)} ${'CKSUM'.padStart(5)}`)
  for (const r of rows) out.push(fmtRow(r.depth, r.dev))
  for (const s of sectionRows) {
    out.push(`${IND}${s.title}`)
    for (const r of s.rows) out.push(fmtRow(r.depth, r.dev))
  }
  out.push('', `errors: ${m.errors ?? 'No known data errors'}`)
  return out.join('\n')
}

export const SEE = (code: string) => `https://openzfs.github.io/openzfs-docs/msg/${code}`
