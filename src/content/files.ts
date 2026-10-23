/**
 * The sample files that live in the game's pools. cat.png is real pixel art:
 * 16×16 palette indices, four rows per 64-byte block, so damage to one block
 * visibly garbles one band of the picture.
 */
import { BLOCK_BYTES, textBytes } from '../zfs/blocktree'

export const PALETTE = [
  '#0b1222', // 0 background
  '#141018', // 1 outline
  '#f0973a', // 2 fur
  '#c4621f', // 3 stripes
  '#f7efe3', // 4 white
  '#ff8fb1', // 5 nose
  '#5fe08a', // 6 eyes
  '#5b4cc4', // 7 hat
  '#e63946', // 8 bow tie
  '#ffd166', // 9 band / gold
  '#3a86ff', // 10 blue eyes
]

const CAT = [
  '................',
  '.11..........11.',
  '.121........121.',
  '.1221......1221.',
  '.12221111112221.',
  '.12232232232221.',
  '1226622222266221',
  '1226122222216221',
  '1222222222222221',
  '1222222552222221',
  '1222212112122221',
  '1442222112222441',
  '.14422222222441.',
  '..122222222221..',
  '...1111111111...',
  '................',
]

const toBytes = (rows: string[]) => {
  const out = new Uint8Array(rows.length * 16)
  rows.forEach((r, y) => {
    for (let x = 0; x < 16; x++) {
      const ch = r[x]
      out[y * 16 + x] = ch === '.' ? 0 : ch === 'a' ? 10 : Number(ch)
    }
  })
  return out
}

export function catBlocks(): Uint8Array[] {
  const all = toBytes(CAT)
  return [0, 1, 2, 3].map((i) => all.slice(i * BLOCK_BYTES, (i + 1) * BLOCK_BYTES))
}

/** Edits the player can make, each touching exactly one block. */
export const CAT_EDITS: Array<{ id: string; label: string; block: number; rows: string[] }> = [
  { id: 'hat', label: 'Top hat', block: 0, rows: ['.....111111.....', '.11..177771..11.', '.121.199991.121.', '.122111111111221'] },
  { id: 'eyes', label: 'Blue eyes', block: 1, rows: ['.12221111112221.', '.12232232232221.', '122aa222222aa221', '122a12222221a221'] },
  { id: 'smile', label: 'Smile', block: 2, rows: ['1222222222222221', '1222222552222221', '1222122222212221', '1442211111122441'] },
  { id: 'bow', label: 'Bow tie', block: 3, rows: ['.14422222222441.', '..128822228821..', '...1888998881...', '....88....88....'] },
]

export function editBytes(rows: string[]) {
  return toBytes(rows)
}

/** Draws a 16×16 image from blocks. Blocks that fail verification draw from their damaged bytes. */
export function drawPixels(canvas: HTMLCanvasElement, blocks: Array<Uint8Array | null>) {
  canvas.width = 16
  canvas.height = 16
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  blocks.forEach((b, bi) => {
    for (let i = 0; i < BLOCK_BYTES; i++) {
      const x = i % 16
      const y = bi * 4 + Math.floor(i / 16)
      const v = b ? b[i] : 0
      ctx.fillStyle = v < PALETTE.length ? PALETTE[v] : `hsl(${(v * 47) % 360} 80% ${30 + (v % 40)}%)`
      if (!b) ctx.fillStyle = '#000'
      ctx.fillRect(x, y, 1, 1)
    }
  })
}

export const NOTES = textBytes('TODO: scrub the pool monthly. Buy more disks. Never use RAID-5.')
export const BUDGET = textBytes('month,disks,usd\njan,4,560\nfeb,2,280\nmar,0,0\napr,8,1120')
export const POEM = textBytes('Copy on write, never in place; the uberblock holds the tree.')

export function bytesToText(b: Uint8Array) {
  let s = ''
  for (const c of b) {
    if (c === 0) break
    s += c >= 32 && c < 127 ? String.fromCharCode(c) : c === 10 ? '\n' : '·'
  }
  return s
}
