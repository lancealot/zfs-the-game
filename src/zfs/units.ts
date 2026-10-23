/** Sizes the way zfs/zpool print them: binary units, three significant digits. */
export function fmtSize(bytes: number): string {
  const units = ['B', 'K', 'M', 'G', 'T', 'P']
  let v = bytes
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  if (i === 0) return `${Math.round(v)}${units[i]}`
  const s = v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)
  return `${s}${units[i]}`
}

export const TB = 1e12

export const hex = (n: number) => n.toString(16)

/** C library ctime() style, as zpool and zdb print dates: "Thu Oct 23 03:21:00 2026" (UTC here). */
export function ctime(d: Date = new Date()): string {
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${day} ${mon} ${String(d.getUTCDate()).padStart(2, ' ')} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${d.getUTCFullYear()}`
}
