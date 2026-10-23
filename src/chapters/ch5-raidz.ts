import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import type { ChapterDef, Ctx } from './types'
import { C, DriveView, makeLabel, burst, cosmicRay, detach, v3 } from '../engine/kit'
import { Ease } from '../engine/anim'
import { h } from '../ui/dom'
import { raidzMap, reconstructPQ, type Cell } from '../zfs/raidz'

const CELL_W = 1.5
const CELL_H = 0.34
const CELL_GAP = 0.08
const ROWS = 12
const cellGeo = new RoundedBoxGeometry(CELL_W, CELL_H, 1.0, 2, 0.05)
cellGeo.userData.shared = true

interface Placed extends Cell {
  block: number
  mesh: THREE.Mesh
  mat: THREE.MeshStandardMaterial
}

const KIND_COLOR: Record<Cell['kind'], string> = { D: C.data, P: C.parity, Q: '#7a6cff', R: '#ff6cd2', skip: '#3a4560' }
const bits = (v: number) => Array.from({ length: 8 }, (_, i) => (v >> (7 - i)) & 1)

export const chapter5: ChapterDef = {
  id: 'raidz',
  num: 5,
  title: 'RAIDZ',
  tagline: 'Stripe blocks across disks with parity, rebuild a dead disk by hand, and see why RAIDZ has no write hole.',
  tags: ['parity', 'XOR', 'resilver', 'write hole'],
  summary: [
    'RAIDZ splits each block across the disks and adds [[parity]] for every row: XOR for RAIDZ1.',
    'Stripes are variable width. Small blocks still pay a whole parity sector, plus padding to a multiple of parity + 1.',
    'Any one missing sector per row can be recomputed (two with RAIDZ2, three with RAIDZ3).',
    'Full-stripe copy-on-write means no [[write-hole|write hole]], and [[resilver|resilvers]] copy only live data.',
  ],
  quiz: [
    {
      q: 'In RAIDZ1, how is a row\'s parity sector computed?',
      options: ['XOR of the data sectors in that row', 'A copy of the row\'s first data sector', 'The fletcher4 checksum of the block', 'A Reed–Solomon code over the whole disk'],
      answer: 0,
      explain: 'P = D0 ⊕ D1 ⊕ D2 … XOR every survivor together with P and the missing sector falls out. RAIDZ2 and RAIDZ3 add Reed–Solomon parities on top.',
    },
    {
      q: 'Why does a single 4 KiB block on a 4-disk RAIDZ1 with 4 KiB sectors take 8 KiB?',
      options: ['It needs one parity sector: 1 data + 1 parity', 'ZFS always mirrors small blocks', 'The checksum takes 4 KiB', 'RAIDZ1 always writes to every disk'],
      answer: 0,
      explain: 'Every row needs parity, even a row with a single data sector. That\'s why small-block workloads (databases, zvols) are often better on mirrors.',
    },
    {
      q: 'Why doesn\'t RAIDZ suffer from the RAID-5 write hole?',
      options: [
        'It never updates a stripe in place; each write is a full new stripe committed by copy-on-write',
        'It writes parity before data',
        'It uses a battery-backed cache',
        'It verifies parity on every read',
      ],
      answer: 0,
      explain: 'A crash can only lose a stripe that was never committed. The old stripe and its parity stay untouched until the new uberblock points elsewhere.',
    },
    {
      q: 'What does a ZFS resilver copy onto a replacement disk?',
      options: ['Only the blocks that are actually allocated', 'Every sector of the disk, start to finish', 'Only metadata blocks', 'Only blocks written in the last txg'],
      answer: 0,
      explain: 'ZFS walks the block tree, so free space is skipped. A mostly empty pool resilvers in minutes.',
    },
  ],

  async run(ctx: Ctx) {
    const { stage, hud, term, sound, scope, root } = ctx
    stage.camera.position.set(0, 12, 30)
    stage.controls.target.set(0, 3, 0)

    // --------------------------------------------------------------- towers
    let width = 4
    let parity = 1
    let towers: THREE.Group[] = []
    let drives: DriveView[] = []
    let cells = new Map<string, Placed>()
    let cursor = 0
    let blockCount = 0
    const dead = new Set<number>()
    const towerGroup = new THREE.Group()
    root.add(towerGroup)
    const names = ['sda', 'sdb', 'sdc', 'sdd', 'sde', 'sdf']

    const colX = (d: number) => (d - (width - 1) / 2) * 2.1
    const cellPos = (d: number, row: number) => v3(colX(d), 0.75 + row * (CELL_H + CELL_GAP) + CELL_H / 2, 0)

    function buildTowers() {
      for (const c of [...towerGroup.children]) detach(c)
      cells.forEach((c) => c.mat.dispose())
      cells = new Map()
      towers = []
      drives = []
      cursor = 0
      blockCount = 0
      dead.clear()
      for (let d = 0; d < width; d++) {
        const g = new THREE.Group()
        const drive = new DriveView(names[d], '4 TB')
        drive.position.set(colX(d), 0, 0)
        drive.label.position.set(0, -0.1, 1.2)
        drive.label.center.set(0.5, 0)
        g.add(drive)
        // Faint rails showing empty sector slots.
        const rail = new THREE.Mesh(
          new THREE.BoxGeometry(CELL_W + 0.1, ROWS * (CELL_H + CELL_GAP), 0.04),
          new THREE.MeshStandardMaterial({ color: '#16213a', transparent: true, opacity: 0.6 }),
        )
        rail.position.set(colX(d), 0.75 + (ROWS * (CELL_H + CELL_GAP)) / 2, -0.55)
        g.add(rail)
        towerGroup.add(g)
        towers.push(g)
        drives.push(drive)
      }
      const lbl = makeLabel(`raidz${parity}-0 · ${width} disks`, 'title')
      lbl.position.set(0, 0.75 + ROWS * (CELL_H + CELL_GAP) + 0.6, 0)
      towerGroup.add(lbl)
      paintStats()
    }

    function blockTint(block: number, kind: Cell['kind']) {
      const base = new THREE.Color(KIND_COLOR[kind])
      if (kind === 'D') base.offsetHSL(((block % 5) - 2) * 0.035, 0, ((block % 3) - 1) * 0.05)
      return base
    }

    function placeCell(c: Cell, block: number): Placed {
      const color = blockTint(block, c.kind)
      const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: c.kind === 'skip' ? 0.05 : 0.28, roughness: 0.4, transparent: true })
      const mesh = new THREE.Mesh(cellGeo, mat)
      mesh.castShadow = true
      mesh.position.copy(cellPos(c.disk, c.row))
      towerGroup.add(mesh)
      const p: Placed = { ...c, block, mesh, mat }
      cells.set(`${c.disk}:${c.row}`, p)
      const lab = c.kind === 'skip' ? 'pad' : c.kind === 'D' ? `D${c.index}` : `${c.kind}${c.index}`
      stage.pick(mesh, {
        tooltip: () =>
          dead.has(c.disk)
            ? `${names[c.disk]} is dead · this sector must be rebuilt`
            : `block ${block} · ${c.kind === 'skip' ? 'padding (skip sector)' : c.kind === 'D' ? `data sector ${c.index}` : `${c.kind} parity, row ${c.index}`} · byte ${c.kind === 'skip' ? '—' : `0x${c.value.toString(16).padStart(2, '0')}`}`,
      })
      void lab
      return p
    }

    async function writeBlock(sectors: number, fast = false) {
      const data = Array.from({ length: sectors }, () => 1 + Math.floor(Math.random() * 254))
      const map = raidzMap(data, width, parity, cursor)
      const block = blockCount++
      const placed = map.cells.map((c) => placeCell(c, block))
      // Fly in from above, column by column.
      for (const p of placed) {
        const target = p.mesh.position.clone()
        p.mesh.position.set(target.x - 7, target.y + 4, 2)
        p.mat.opacity = 0
      }
      sound.write()
      await Promise.all(
        placed.map((p, i) => {
          const target = cellPos(p.disk, p.row)
          const from = p.mesh.position.clone()
          return ctx.sleep((fast ? 0.02 : 0.06) * i).then(() =>
            ctx.tween(fast ? 0.35 : 0.6, (k) => {
              p.mesh.position.lerpVectors(from, target, k)
              p.mat.opacity = Math.min(1, k * 2)
            }, Ease.out),
          )
        }),
      )
      cursor += map.asize
      paintStats()
      return { block, map, placed }
    }

    // ----------------------------------------------------------- side panel
    const statsEl = h('div', { class: 'note', style: { marginTop: '0' } })
    const legend = h(
      'div',
      { class: 'legend', style: { marginTop: '8px' } },
      h('span', null, h('i', { style: { background: C.data } }), 'data'),
      h('span', null, h('i', { style: { background: C.parity } }), 'P parity'),
      h('span', null, h('i', { style: { background: KIND_COLOR.Q } }), 'Q parity'),
      h('span', null, h('i', { style: { background: KIND_COLOR.skip } }), 'padding'),
    )
    const puzzleEl = h('div')
    hud.info(h('div', null, h('h3', null, 'Vdev'), statsEl, legend, puzzleEl))

    function paintStats() {
      const all = [...cells.values()]
      const data = all.filter((c) => c.kind === 'D').length
      const par = all.filter((c) => c.kind === 'P' || c.kind === 'Q' || c.kind === 'R').length
      const pad = all.filter((c) => c.kind === 'skip').length
      const total = data + par + pad
      statsEl.textContent = total
        ? `${blockCount} block${blockCount === 1 ? '' : 's'}: ${data} data, ${par} parity, ${pad} padding sectors. ${Math.round((data / total) * 100)}% of the allocated space holds data.`
        : `raidz${parity} with ${width} disks: ${width - parity} disks' worth of data per full row.`
      hud.stats([
        { k: 'layout', v: `raidz${parity} × ${width}` },
        { k: 'state', v: dead.size ? (dead.size > parity ? 'UNAVAIL' : 'DEGRADED') : 'ONLINE', kind: dead.size ? (dead.size > parity ? 'bad' : 'warn') : 'ok', narrowHide: true },
      ])
    }

    function killDisk(d: number) {
      dead.add(d)
      drives[d].setState('bad')
      for (const c of cells.values()) {
        if (c.disk !== d) continue
        c.mat.color.set('#2a2f3c')
        c.mat.emissive.set('#000000')
        c.mat.opacity = 0.35
      }
      paintStats()
    }

    function restoreCell(c: Placed) {
      const color = blockTint(c.block, c.kind)
      c.mat.color.copy(color)
      c.mat.emissive.copy(color)
      c.mat.emissiveIntensity = 0.9
      c.mat.opacity = 1
      burst(scope, towerGroup, c.mesh.position.clone(), KIND_COLOR[c.kind], 10, 0.6)
      setTimeout(() => (c.mat.emissiveIntensity = c.kind === 'skip' ? 0.05 : 0.28), 500)
    }

    /** P_k and the data sectors it covers (position k of each data column), in column order. */
    function rowOf(block: number, k: number) {
      return [...cells.values()]
        .filter((c) => c.block === block && c.k === k && (c.kind === 'D' || c.kind === 'P'))
        .sort((a, b) => a.col - b.col)
    }

    // ------------------------------------------------------------- puzzles
    async function xorPuzzle(members: Placed[], missing: Placed, round: number): Promise<void> {
      const guess = [0, 0, 0, 0, 0, 0, 0, 0]
      return scope.guard(
        new Promise<void>((resolve) => {
          const render = (feedback = '') => {
            const rows = members.map((m) => {
              const label = m.kind === 'P' ? `P · ${names[m.disk]}` : `D${m.index} · ${names[m.disk]}`
              if (m === missing) {
                return h(
                  'div',
                  { class: 'row' },
                  h('span', { class: 'missing' }, label),
                  ...guess.map((b, i) =>
                    h(
                      'button',
                      {
                        class: `bit ${b ? 'one' : ''} ${m.kind === 'P' ? 'parity' : ''}`,
                        'aria-label': `bit ${i}: ${b}`,
                        onclick: () => {
                          guess[i] ^= 1
                          sound.tick()
                          render()
                        },
                      },
                      String(b),
                    ),
                  ),
                )
              }
              return h('div', { class: 'row' }, h('span', null, label), ...bits(m.value).map((b) => h('span', { class: `bit ${b ? 'one' : ''} ${m.kind === 'P' ? 'parity' : ''}` }, String(b))))
            })
            puzzleEl.replaceChildren(
              h('h3', { style: { marginTop: '14px' } }, `Rebuild ${missing.kind === 'P' ? 'the parity' : `D${missing.index}`} · round ${round} of 3`),
              h('div', { class: 'bits' }, ...rows),
              h(
                'div',
                { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '10px', flexWrap: 'wrap' } },
                h(
                  'button',
                  {
                    class: 'btn primary',
                    onclick: () => {
                      const v = guess.reduce((a, b) => (a << 1) | b, 0)
                      if (v === missing.value) {
                        sound.ok()
                        puzzleEl.replaceChildren()
                        resolve()
                      } else {
                        sound.bad()
                        const wrong = bits(missing.value).map((b, i) => (b !== guess[i] ? i : -1)).filter((i) => i >= 0)
                        render(`${wrong.length} bit${wrong.length > 1 ? 's are' : ' is'} off. In each column, the missing bit must make the number of 1s even.`)
                      }
                    },
                  },
                  'Check',
                ),
                feedback ? h('span', { class: 'note', style: { margin: '0', color: 'var(--red)' } }, feedback) : null,
              ),
            )
          }
          render()
        }),
      )
    }

    // ------------------------------------------------------------ terminal
    let replaceRequested = false
    term.setHandler(
      (argv) => {
        const [cmd, a1, , a3, a4] = argv
        if (cmd === 'zpool' && a1 === 'status') {
          const vname = `raidz${parity}-0`
          const lines = [
            '  pool: tank',
            ` state: ${dead.size ? 'DEGRADED' : 'ONLINE'}`,
            dead.size ? 'status: One or more devices could not be opened.  Sufficient replicas exist for\n        the pool to continue functioning in a degraded state.' : '',
            '  scan: none requested',
            'config:',
            '',
            '        NAME        STATE     READ WRITE CKSUM',
            `        tank        ${(dead.size ? 'DEGRADED' : 'ONLINE').padEnd(8)}     0     0     0`,
            `          ${vname.padEnd(8)}  ${(dead.size ? 'DEGRADED' : 'ONLINE').padEnd(8)}     0     0     0`,
            ...names.slice(0, width).map((n, i) => `            ${n.padEnd(6)}  ${(dead.has(i) ? 'UNAVAIL' : 'ONLINE').padEnd(8)}     0     0     0${dead.has(i) ? '  cannot open' : ''}`),
            '',
            'errors: No known data errors',
          ].filter(Boolean)
          term.print(lines.join('\n'))
          return true
        }
        if (cmd === 'zpool' && a1 === 'replace') {
          if (!dead.size) term.print('cannot replace: no failed device in this pool', 'err')
          else {
            replaceRequested = true
            void a3
            void a4
          }
          return true
        }
        return false
      },
      ['Commands in this chapter:', '  zpool status', '  zpool replace tank sdb sde    swap the dead disk for a new one'].join('\n'),
    )
    term.setSuggestions(['zpool status'])

    // -------------------------------------------------------------- script
    buildTowers()
    await ctx.fly(v3(0, 7.5, 17), v3(0, 3.2, 0), 2)
    ctx.objectives([
      { id: 'stripe', text: 'Write a block and watch it stripe with parity' },
      { id: 'small', text: 'Write small blocks and find the padding' },
      { id: 'xor', text: 'A disk died: rebuild 3 sectors by hand with XOR' },
      { id: 'resilver', text: 'Replace the disk and resilver' },
      { id: 'hole', text: 'See why RAIDZ has no write hole' },
      { id: 'z2', text: 'Lose two disks at once with RAIDZ2' },
    ])
    ctx.unlock('raidz', 'parity')

    await ctx.next(
      'Four 4 TB disks in a **RAIDZ1** vdev. Each tower is one disk; each slab is one 4 KiB sector. Let\'s see where a block actually goes.',
    )
    hud.setActions([{ id: 'w6', label: 'Write a 24 KiB block', cmd: '6 sectors', kind: 'primary', glow: true, onClick: () => void writeBlock(6).catch(() => {}) }])
    ctx.say('Press **Write a 24 KiB block**: six 4 KiB sectors of data.')
    await ctx.until(() => blockCount >= 1)
    hud.setActions([])
    await ctx.sleep(0.5)
    ctx.check('stripe')
    await ctx.next(
      'The block was split into sectors and spread **down the columns**: D0 and D1 on one disk, D2 and D3 on the next, and so on. The violet sectors are parity: each one is the XOR of the data sectors in its row. 6 data + 2 parity = 8 sectors.',
    )

    // Small blocks
    let smallWrites = 0
    hud.setActions([
      { id: 'w1', label: '4 KiB block', cmd: '1 sector', onClick: () => void writeBlock(1).then(() => smallWrites++).catch(() => {}) },
      { id: 'w2', label: '8 KiB block', cmd: '2 sectors', onClick: () => void writeBlock(2).then(() => smallWrites++).catch(() => {}) },
      { id: 'w5', label: '20 KiB block', cmd: '5 sectors', onClick: () => void writeBlock(5).then(() => smallWrites++).catch(() => {}) },
    ])
    ctx.say('RAIDZ stripes are **variable width**: each block gets exactly as many columns as it needs. Write a few small blocks with the buttons and watch for gray padding sectors.')
    await ctx.until(() => smallWrites >= 2 && [...cells.values()].some((c) => c.kind === 'skip'))
    await ctx.sleep(0.4)
    ctx.check('small')
    await ctx.next(
      'A 4 KiB block costs **8 KiB**: one data sector plus a whole parity sector. An 8 KiB block needs 3 sectors, and RAIDZ rounds every allocation up to a multiple of parity + 1, so it gets a gray **padding** sector too. Small blocks waste space on RAIDZ, which is why databases and VM disks often live on mirrors.',
    )
    hud.setActions([])
    while (cursor < width * 7) await writeBlock(3 + Math.floor(Math.random() * 6), true)

    // Disk death + XOR puzzle
    await ctx.next('Now the bad news.', 'Kill a disk')
    const victim = 1
    await cosmicRay(scope, towerGroup, drives[victim].position.clone().setY(0.4), C.bad, 0.4)
    sound.zap()
    killDisk(victim)
    ctx.unlock('states')
    await ctx.next(
      `\`${names[victim]}\` is dead. The vdev is **DEGRADED** but every block is still readable, because any one missing sector in a row can be recomputed. Let's do it by hand. Toggle the missing bits so that every bit column has an **even** number of 1s. That's XOR.`,
    )
    // Pick three rows: two where the dead disk held data, one where it held parity.
    const blocksWithParity = [...new Set([...cells.values()].filter((c) => c.kind === 'P').map((c) => c.block))]
    const rounds: Array<{ members: Placed[]; missing: Placed }> = []
    for (const b of blocksWithParity) {
      const pcs = [...cells.values()].filter((c) => c.block === b && c.kind === 'P')
      for (const p of pcs) {
        const members = rowOf(b, p.k)
        const missing = members.find((m) => m.disk === victim)
        if (!missing || members.length < 3) continue
        const isParity = missing.kind === 'P'
        const dataRounds = rounds.filter((r) => r.missing.kind === 'D').length
        if (!isParity && dataRounds < 2) rounds.push({ members, missing })
        else if (isParity && !rounds.some((r) => r.missing.kind === 'P')) rounds.push({ members, missing })
      }
      if (rounds.length >= 3) break
    }
    rounds.sort((a, b) => (a.missing.kind === 'P' ? 1 : 0) - (b.missing.kind === 'P' ? 1 : 0))
    for (let i = 0; i < rounds.length; i++) {
      const r = rounds[i]
      r.missing.mat.emissive.set(C.uber)
      r.missing.mat.emissiveIntensity = 0.8
      r.missing.mat.opacity = 0.8
      if (i === 0) ctx.say('The glowing slab on the dead disk is missing. Its row-mates are in the panel on the right. Fill in the bits, then press **Check**.')
      else if (r.missing.kind === 'P') ctx.say('This time the dead disk held the **parity** sector. Same rule: make every column even.')
      else ctx.say('Nice. Another row, another missing data sector.')
      await xorPuzzle(r.members, r.missing, i + 1)
      restoreCell(r.missing)
    }
    ctx.check('xor')
    await ctx.next('That\'s exactly what ZFS does on every read from a degraded RAIDZ1, millions of times per second, in optimized code.')

    // Resilver
    ctx.unlock('resilver', 'zpool-replace')
    hud.setActions([{ id: 'replace', label: 'Replace the disk', cmd: `zpool replace tank ${names[victim]} sde`, kind: 'primary', glow: true, onClick: () => (replaceRequested = true) }])
    term.setSuggestions(['zpool status', `zpool replace tank ${names[victim]} sde`])
    ctx.say(`Slide a fresh disk in and press **Replace the disk** (or type \`zpool replace tank ${names[victim]} sde\`).`)
    await ctx.until(() => replaceRequested)
    hud.setActions([])
    term.echo(`zpool replace tank ${names[victim]} sde`)
    drives[victim].setState('ok')
    drives[victim].label.element.innerHTML = '<b>sde</b><span>new</span>'
    const allocatedRows = new Set([...cells.values()].filter((c) => c.disk === victim).map((c) => c.row))
    let rebuilt = 0
    for (let row = 0; row < ROWS; row++) {
      const marker = cellPos(victim, row)
      burst(scope, towerGroup, marker, C.white, 4, 0.3)
      if (allocatedRows.has(row)) {
        const c = cells.get(`${victim}:${row}`)!
        restoreCell(c)
        sound.write()
        rebuilt++
        await ctx.sleep(0.25)
      } else await ctx.sleep(0.05)
    }
    dead.delete(victim)
    paintStats()
    ctx.check('resilver')
    term.print(`  scan: resilvered ${rebuilt * 4}K in 00:00:03 with 0 errors`, 'ok')
    await ctx.next(
      `The resilver rebuilt only the ${rebuilt} sectors that hold data, skipping empty space. A hardware RAID rebuild copies the entire 4 TB disk whether it's used or not, taking around 8 hours. On a mostly empty pool, ZFS finishes in minutes.`,
    )

    // Write hole
    ctx.unlock('write-hole')
    const victimBlock = [...cells.values()].find((c) => c.kind === 'D' && c.block === 0)!
    const parityCell = rowOf(0, 0).find((c) => c.kind === 'P')!
    await ctx.next(
      'Last lesson: the infamous **RAID-5 write hole**. Suppose this were RAID-5 and an app changed one data sector. RAID-5 overwrites the sector **in place**, then overwrites the parity. Two separate writes.',
      'Show me',
    )
    victimBlock.mat.emissive.set(C.white)
    victimBlock.mat.emissiveIntensity = 1.6
    sound.write()
    await ctx.sleep(0.6)
    sound.power()
    const flash = h('div', { style: { position: 'fixed', inset: '0', background: '#000', opacity: '0.85', zIndex: '45', pointerEvents: 'none', transition: 'opacity 0.6s' } })
    document.getElementById('app')!.append(flash)
    scope.add(() => flash.remove())
    await ctx.sleep(0.5)
    flash.style.opacity = '0'
    parityCell.mat.color.set(C.corrupt)
    parityCell.mat.emissive.set(C.corrupt)
    parityCell.mat.emissiveIntensity = 1.2
    await ctx.next(
      'Power failed between the two writes. The data changed but the parity didn\'t, and **nothing records that**. Everything looks fine, until a disk dies and the stale parity rebuilds garbage. That\'s the write hole.',
    )
    victimBlock.mat.emissiveIntensity = 0.28
    restoreCell(parityCell)
    await ctx.next(
      'RAIDZ never updates a stripe in place. A changed block is written as a **brand-new full stripe** in free space, with its own fresh parity. The old stripe stays untouched until the uberblock commits. A crash can only lose a stripe that was never committed: no hole.',
    )
    const nb = await writeBlock(6)
    for (const c of [...cells.values()].filter((c) => c.block === 0)) {
      void ctx.tween(0.8, (k) => (c.mat.opacity = 1 - 0.75 * k)).catch(() => {})
    }
    void nb
    ctx.check('hole')
    await ctx.sleep(0.8)

    // RAIDZ2
    await ctx.next('One disk of parity is thin protection for big disks: a second failure during a long resilver loses the vdev. Let\'s rebuild as **RAIDZ2** with five disks.', 'Build RAIDZ2')
    width = 5
    parity = 2
    buildTowers()
    while (cursor < width * 8) await writeBlock(3 + Math.floor(Math.random() * 7), true)
    await ctx.next('Every row now has two parity sectors: **P** (XOR, violet) and **Q** (blue-violet), computed with Reed–Solomon math over GF(2⁸).', 'Kill two disks')
    await Promise.all([1, 3].map((d) => cosmicRay(scope, towerGroup, drives[d].position.clone().setY(0.4), C.bad, 0.4)))
    sound.zap()
    killDisk(1)
    killDisk(3)
    await ctx.sleep(0.6)
    // Reconstruct every row that lost data, using P and Q, and check the math.
    let solved = 0
    let verified = true
    const blocksNow = [...new Set([...cells.values()].map((c) => c.block))]
    for (const b of blocksNow) {
      const bcs = [...cells.values()].filter((c) => c.block === b)
      for (const p of bcs.filter((c) => c.kind === 'P')) {
        const q = bcs.find((c) => c.kind === 'Q' && c.k === p.k)!
        // Every data column of the stripe, in order; columns too short for this row count as zero.
        const dataCols = [...new Set(bcs.filter((c) => c.kind === 'D').map((c) => c.col))].sort((a, c2) => a - c2)
        const ordered = dataCols.map((col) => bcs.find((c) => c.kind === 'D' && c.col === col && c.k === p.k) ?? null)
        const lostIdx = ordered.map((c, i) => (c && dead.has(c.disk) ? i : -1)).filter((i) => i >= 0)
        if (lostIdx.length === 2 && !dead.has(p.disk) && !dead.has(q.disk)) {
          const [x, y] = lostIdx
          const row = ordered.map((c, i) => (i === x || i === y ? null : (c?.value ?? 0)))
          const [dx, dy] = reconstructPQ(row, x, y, p.value, q.value)
          if (dx !== ordered[x]!.value || dy !== ordered[y]!.value) verified = false
          solved += 2
        }
      }
    }
    for (const c of [...cells.values()].filter((c) => dead.has(c.disk))) {
      restoreCell(c)
      await ctx.sleep(0.04)
    }
    ctx.check('z2')
    await ctx.next(
      `Two disks gone and every sector rebuilt${solved ? `, including ${solved} sectors that needed both P and Q (solving two equations in GF(2⁸)${verified ? ', and checked exactly' : ''})` : ''}. RAIDZ2 is the usual choice for big HDDs; RAIDZ3 adds a third parity for very wide vdevs.`,
      'Take the checkpoint',
    )
    await ctx.finish()
  },
}
