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
