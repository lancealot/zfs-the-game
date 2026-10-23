import type { ChapterDef, Ctx } from './types'
import { BlockView, Platter, C, makeLabel, pulse, cosmicRay, burst, v3 } from '../engine/kit'
import { h } from '../ui/dom'
import { fletcher4, cksumEqual, type Cksum } from '../zfs/checksum'
import { noiseBytes } from '../zfs/blocktree'
import { formatStatus, SEE } from '../zfs/status'
import { catBlocks, drawPixels, NOTES, BUDGET, POEM } from '../content/files'

interface LBlock {
  file: string
  index: number
  data: Uint8Array
  cksum: Cksum
  slot: number
  copies: [Uint8Array, Uint8Array]
  badSince: [number | null, number | null]
  lost: boolean
  view: BlockView
}

const STORM_SECONDS = 45
const GRACE = 4

export const chapter4: ChapterDef = {
  id: 'heal',
  num: 4,
  title: 'Self-Healing',
  tagline: 'Cosmic rays are flipping bits on a mirror. Watch ZFS repair them, then survive the storm.',
  tags: ['checksums', 'self-healing', 'scrub', 'mirror'],
  summary: [
    'Every read is verified. On a mirror or RAIDZ, a bad copy is [[selfheal|repaired automatically]] from a good one.',
    'Hardware RAID without checksums can\'t tell which copy is right, so it can return bad data.',
    '[[scrub|Scrubs]] find damage in data nobody reads, before the last good copy is gone.',
    'Damage that can\'t be repaired is reported per file by `zpool status -v`.',
  ],
  quiz: [
    {
      q: 'ZFS reads a block from a mirror and the checksum fails. What happens next?',
      options: [
        'It reads the other copy, returns the good data, and rewrites the bad copy',
        'It returns an I/O error to the application right away',
        'It returns the data anyway and logs a warning',
        'It takes the disk offline immediately',
      ],
      answer: 0,
      explain: 'That\'s self-healing. The application never sees the bad data, and the CKSUM counter on that disk goes up so you know something happened.',
    },
    {
      q: 'Why can\'t a plain hardware RAID-1 fix silent corruption?',
      options: [
        'Without checksums it can\'t tell which of two different copies is correct',
        'It doesn\'t actually keep two copies',
        'It only works with SSDs',
        'It can, but only during a rebuild',
      ],
      answer: 0,
      explain: 'Two copies disagree and nothing says which one is right. A rebuild may even copy the bad one over the good one.',
    },
    {
      q: 'What does `zpool scrub` do?',
      options: [
        'Reads every allocated block, verifies it, and repairs bad copies',
        'Defragments the pool',
        'Overwrites free space with zeros',
        'Checks only the metadata',
      ],
      answer: 0,
      explain: 'A scrub is a read of everything. It catches corruption in data nobody happens to read, while a good copy still exists.',
    },
    {
      q: 'A file appears under "Permanent errors" in `zpool status -v`. What does that mean?',
      options: [
        'Every copy of at least one of its blocks failed its checksum',
        'One disk of the mirror was removed',
        'The file was deleted while it was open',
        'The pool is out of space',
      ],
      answer: 0,
      explain: 'ZFS ran out of good copies for some block of that file, so it can\'t return correct data. Restore that file from backup.',
    },
  ],

  async run(ctx: Ctx) {
    const { stage, hud, term, sound, scope, root } = ctx
    stage.camera.position.set(0, 16, 30)
    stage.controls.target.set(0, 2.5, 0)

    // ---------------------------------------------------------------- scene
    const disks = [new Platter(6, 4, 0.9, 'sda'), new Platter(6, 4, 0.9, 'sdb')]
    disks[0].position.set(-4.4, 0, 2.6)
    disks[1].position.set(4.4, 0, 2.6)
    disks.forEach((d) => root.add(d))
    const mirrorLbl = makeLabel('mirror-0 · every block is stored on both disks', 'platter')
    mirrorLbl.position.set(0, 0.2, 6.2)
    mirrorLbl.center.set(0.5, 0)
    root.add(mirrorLbl)

    const fileSpecs: Array<{ name: string; blocks: Uint8Array[] }> = [
      { name: 'cat.png', blocks: catBlocks() },
      { name: 'notes.txt', blocks: [NOTES] },
      { name: 'song.mp3', blocks: [noiseBytes(31), noiseBytes(32), noiseBytes(33)] },
      { name: 'budget.csv', blocks: [BUDGET] },
      { name: 'poem.txt', blocks: [POEM] },
      { name: 'photo.raw', blocks: [noiseBytes(41), noiseBytes(42)] },
    ]
    const perm = [3, 9, 14, 20, 1, 17, 6, 11, 22, 8, 15, 0]
    const blocks: LBlock[] = []
    let x = 0
    const groupX: Array<{ name: string; from: number; to: number }> = []
    fileSpecs.forEach((f) => {
      const from = x
      f.blocks.forEach((data, index) => {
        const view = new BlockView(C.data, 0.62, 0.4)
        root.add(view)
        const lb: LBlock = {
          file: f.name,
          index,
          data,
          cksum: fletcher4(data),
          slot: perm[blocks.length],
          copies: [new Uint8Array(data), new Uint8Array(data)],
          badSince: [null, null],
          lost: false,
          view,
        }
        view.userData.x = x
        blocks.push(lb)
        x += 1
      })
      groupX.push({ name: f.name, from, to: x - 1 })
      x += 0.6
    })
    const span = x - 0.6 - 1
    for (const lb of blocks) lb.view.position.set((lb.view.userData.x as number) - span / 2, 4.8, -1.4)
    for (const g of groupX) {
      const l = makeLabel(g.name, 'faint')
      l.position.set((g.from + g.to) / 2 - span / 2, 4.15, -1.4)
      l.center.set(0.5, 0)
      root.add(l)
    }

    const tilePos = (lb: LBlock, side: number) => disks[side].worldSlot(lb.slot)

    // ---------------------------------------------------------------- state
    let mode: 'zfs' | 'raid' = 'zfs'
    let rr = 0
    const cksumErrs = [0, 0]
    let repairedBytes = 0
    let lastScan = 'none requested'
    let busy = false
    let clock = 0
    let scrubbing = false
    let scrubCooldown = 0
    let interactive = false
    scope.onUpdate((dt) => {
      clock += dt
      scrubCooldown = Math.max(0, scrubCooldown - dt)
    })

    const isBad = (lb: LBlock, side: number) => !cksumEqual(fletcher4(lb.copies[side]), lb.cksum)

    function paint() {
      for (const lb of blocks) {
        for (const side of [0, 1]) disks[side].setTile(lb.slot, isBad(lb, side) ? C.corrupt : C.data, isBad(lb, side) ? 1.2 : 0.45)
        lb.view.setColor(lb.lost ? C.corrupt : C.data)
        lb.view.setGlow(lb.lost ? 1.1 : 0.4)
      }
      hud.stats([
        { k: 'sda CKSUM', v: String(cksumErrs[0]), kind: cksumErrs[0] ? 'warn' : undefined },
        { k: 'sdb CKSUM', v: String(cksumErrs[1]), kind: cksumErrs[1] ? 'warn' : undefined },
        { k: 'mode', v: mode === 'zfs' ? 'ZFS mirror' : 'HW RAID-1', kind: mode === 'zfs' ? 'ok' : 'bad', narrowHide: true },
      ])
    }

    function damage(lb: LBlock, side: number) {
      const c = new Uint8Array(lb.copies[side])
      for (let i = 0; i < 14; i++) c[(i * 37 + side * 11 + Math.floor(clock * 7)) % c.length] ^= 0x5a + i
      lb.copies[side] = c
      if (lb.badSince[side] === null) lb.badSince[side] = clock
    }

    async function strike(lb: LBlock, side: number) {
      const at = tilePos(lb, side).setY(0.45)
      await cosmicRay(scope, root, at)
      sound.zap()
      damage(lb, side)
      paint()
    }

    function heal(lb: LBlock, side: number) {
      lb.copies[side] = new Uint8Array(lb.data)
      lb.badSince[side] = null
      repairedBytes += 128
    }

    /** One block read. Returns the bytes handed to the application, or null for EIO. */
    async function readBlock(lb: LBlock, forceSide?: number, fast = false): Promise<Uint8Array | null> {
      const side = forceSide ?? rr++ % 2
      const t = fast ? 0.22 : 0.45
      await pulse(scope, root, [tilePos(lb, side).setY(0.5), lb.view.position.clone()], C.white, t, 0.1)
      sound.read()
      if (mode === 'raid') {
        void lb.view.flash(scope, C.white, 0.4).catch(() => {})
        return lb.copies[side]
      }
      if (!isBad(lb, side)) {
        void lb.view.flash(scope, C.ok, 0.4).catch(() => {})
        return lb.data
      }
      // Checksum mismatch: count it and try the other side.
      cksumErrs[side]++
      void lb.view.flash(scope, C.corrupt, 0.5).catch(() => {})
      sound.bad()
      paint()
      const other = 1 - side
      await pulse(scope, root, [tilePos(lb, other).setY(0.5), lb.view.position.clone()], C.white, t, 0.1)
      if (isBad(lb, other)) {
        cksumErrs[other]++
        lb.lost = true
        paint()
        return null
      }
      void lb.view.flash(scope, C.ok, 0.4).catch(() => {})
      await pulse(scope, root, [lb.view.position.clone(), tilePos(lb, side).setY(0.5)], C.ok, t, 0.12)
      heal(lb, side)
      burst(scope, root, tilePos(lb, side).setY(0.5), C.ok, 14, 0.8)
      sound.write()
      paint()
      return lb.data
    }

    async function readFile(name: string, force: Map<number, number> = new Map()) {
      busy = true
      try {
        term.echo(`cat /tank/home/${name} > /dev/null`)
        const fb = blocks.filter((b) => b.file === name)
        const out: Array<Uint8Array | null> = []
        for (const b of fb) out.push(await readBlock(b, force.get(b.index)))
        if (out.some((o) => o === null)) term.print(`cat: /tank/home/${name}: Input/output error`, 'err')
        if (name === 'cat.png') showPicture(out, mode === 'raid' ? 'What the app received (no error reported!)' : 'What the app received')
        return out
      } finally {
        busy = false
      }
    }

    function showPicture(data: Array<Uint8Array | null>, caption: string) {
      const canvas = h('canvas', { width: 16, height: 16, 'aria-label': 'cat.png as returned to the application' }) as HTMLCanvasElement
      drawPixels(canvas, data)
      hud.inspect({
        eyebrow: 'Read result',
        title: 'cat.png',
        body: h('div', { class: 'pixel-file' }, canvas, h('div', { class: 'note', style: { marginTop: '0' } }, caption)),
      })
    }

    async function scrub() {
      if (scrubbing) return
      scrubbing = true
      term.echo('zpool scrub tank')
      let fixed = 0
      const order = [...blocks].sort((a, b) => a.slot - b.slot)
      for (const lb of order) {
        for (const side of [0, 1]) disks[side].setTile(lb.slot, C.white, 1.4)
        sound.tick()
        await ctx.sleep(0.2)
        if (!lb.lost) {
          const bad = [0, 1].filter((s) => isBad(lb, s))
          if (bad.length === 2) {
            cksumErrs[0]++
            cksumErrs[1]++
            lb.lost = true
          } else if (bad.length === 1) {
            cksumErrs[bad[0]]++
            heal(lb, bad[0])
            fixed++
            burst(scope, root, tilePos(lb, bad[0]).setY(0.5), C.ok, 12, 0.7)
          }
        }
        paint()
      }
      const lost = blocks.filter((b) => b.lost).length
      lastScan = `scrub repaired ${fixed * 128}K in 00:00:0${Math.min(9, Math.round(order.length * 0.2))} with ${lost} errors on ${new Date().toUTCString().slice(0, 25)}`
      term.print(`# scrub finished: ${fixed} bad cop${fixed === 1 ? 'y' : 'ies'} repaired`, fixed ? 'ok' : 'dim')
      scrubbing = false
      scrubCooldown = 8
      return fixed
    }

    function statusText(verbose = true) {
      const errs = cksumErrs[0] + cksumErrs[1] > 0
      const lostFiles = [...new Set(blocks.filter((b) => b.lost).map((b) => b.file))]
      return formatStatus({
        pool: 'tank',
        state: 'ONLINE',
        status: lostFiles.length
          ? 'One or more devices has experienced an error resulting in data\ncorruption.  Applications may be affected.'
          : errs
            ? 'One or more devices has experienced an unrecoverable error.  An\nattempt was made to correct the error.  Applications are unaffected.'
            : undefined,
        action: lostFiles.length
          ? 'Restore the file in question if possible.  Otherwise restore the\nentire pool from backup.'
          : errs
            ? "Determine if the device needs to be replaced, and clear the errors\nusing 'zpool clear' or replace the device with 'zpool replace'."
            : undefined,
        see: lostFiles.length ? SEE('ZFS-8000-8A') : errs ? SEE('ZFS-8000-9P') : undefined,
        scan: lastScan,
        vdevs: [
          {
            name: 'mirror-0',
            state: 'ONLINE',
            children: [
              { name: 'sda', state: 'ONLINE', cksum: cksumErrs[0] },
              { name: 'sdb', state: 'ONLINE', cksum: cksumErrs[1] },
            ],
          },
        ],
        errors: lostFiles.length
          ? verbose
            ? `Permanent errors have been detected in the following files:\n\n${lostFiles.map((f) => `        /tank/home/${f}`).join('\n')}`
            : `${lostFiles.length} data errors, use '-v' for a list`
          : undefined,
      })
    }

    // Clicking a damaged copy points a read at it.
    for (const lb of blocks) {
      for (const side of [0, 1]) {
        const tile = disks[side].tiles[lb.slot]
        stage.pick(tile, {
          tooltip: () => `${lb.file} block ${lb.index} · copy on ${side ? 'sdb' : 'sda'}${isBad(lb, side) ? ' · damaged: click to read it' : ''}`,
          onClick: () => {
            if (!interactive || (busy && !storm.running)) return
            if (storm.running || isBad(lb, side)) void readBlock(lb, side, true).catch(() => {})
          },
        })
      }
      stage.pick(lb.view, {
        onHover: (on) => lb.view.setHover(on),
        tooltip: () => `${lb.file} · block ${lb.index}`,
        onClick: () => {
          if (!interactive) return
          if (storm.running) void readBlock(lb, undefined, true).catch(() => {})
          else if (!busy) void readFile(lb.file).catch(() => {})
        },
      })
    }

    // ---------------------------------------------------------------- storm
    const storm = { running: false, left: 0, nextRay: 0, rays: 0 }
    const stormTime = h('b', null, '—')
    const stormFill = h('div', { class: 'fill', style: { width: '0%' } })
    const stormInfo = h('div', { class: 'note' })
    const scrubFill = h('div', { class: 'fill', style: { width: '100%', background: 'var(--mint)' } })
    const panel = h(
      'div',
      null,
      h('h3', null, 'Cosmic storm'),
      h('div', { class: 'meter' }, h('div', { class: 'lab' }, h('span', null, 'time left'), stormTime), h('div', { class: 'track' }, stormFill)),
      h('div', { class: 'meter' }, h('div', { class: 'lab' }, h('span', null, 'scrub ready'), h('b', null, '')), h('div', { class: 'track' }, scrubFill)),
      stormInfo,
      h('div', { class: 'legend', style: { marginTop: '8px' } }, h('span', null, h('i', { style: { background: C.data } }), 'good copy'), h('span', null, h('i', { style: { background: C.corrupt } }), 'damaged copy')),
    )

    scope.onUpdate((dt) => {
      if (!storm.running) return
      storm.left -= dt
      storm.nextRay -= dt
      const progress = 1 - storm.left / STORM_SECONDS
      if (storm.nextRay <= 0 && storm.left > 0.5) {
        storm.nextRay = 1.5 - 0.85 * progress + Math.random() * 0.3
        const candidates: Array<[LBlock, number]> = []
        for (const lb of blocks) {
          if (lb.lost) continue
          for (const side of [0, 1]) {
            if (isBad(lb, side)) continue
            const partnerSince = lb.badSince[1 - side]
            // Fair play: a block whose other copy just broke gets a few seconds of grace.
            if (partnerSince !== null && clock - partnerSince < GRACE) continue
            candidates.push([lb, side])
          }
        }
        if (candidates.length) {
          const [lb, side] = candidates[Math.floor(Math.random() * candidates.length)]
          storm.rays++
          void strike(lb, side).catch(() => {})
        }
      }
      // A block whose second copy breaks is lost the moment anything tries to read it.
      for (const lb of blocks) if (!lb.lost && isBad(lb, 0) && isBad(lb, 1)) lb.lost = true
      const lost = blocks.filter((b) => b.lost).length
      stormTime.textContent = `${Math.max(0, storm.left).toFixed(0)} s`
      stormFill.style.width = `${progress * 100}%`
      scrubFill.style.width = `${(1 - scrubCooldown / 8) * 100}%`
      stormInfo.textContent = `${storm.rays} rays so far · ${lost} block${lost === 1 ? '' : 's'} lost`
      hud.updateAction('scrub', { disabled: scrubbing || scrubCooldown > 0 })
      if (lost > 0) paint()
      if (storm.left <= 0) storm.running = false
    })

    // ------------------------------------------------------------- terminal
    term.setHandler(
      (argv) => {
        const [cmd, a1, a2] = argv
        if (cmd === 'zpool' && a1 === 'status') {
          term.print(statusText(argv.includes('-v')))
          return true
        }
        if (cmd === 'zpool' && a1 === 'scrub') {
          if (!interactive) term.print('Hold on, Ditto has something to show you first.', 'warn')
          else if (scrubbing || scrubCooldown > 0) term.print(`cannot scrub tank: currently scrubbing`, 'err')
          else void scrub().catch(() => {})
          return true
        }
        if (cmd === 'zpool' && a1 === 'clear') {
          cksumErrs[0] = cksumErrs[1] = 0
          paint()
          return true
        }
        if (cmd === 'cat') {
          const f = (a2 ? a2 : (a1 ?? '')).split('/').pop() ?? ''
          if (!blocks.some((b) => b.file === f)) term.print(`cat: ${a1 ?? ''}: No such file or directory`, 'err')
          else if (busy) term.print('busy, try again in a moment', 'warn')
          else void readFile(f).catch(() => {})
          return true
        }
        return false
      },
      [
        'Commands in this chapter:',
        '  cat /tank/home/cat.png     read a file (verifies every block)',
        '  zpool scrub tank           verify and repair everything',
        '  zpool status -v            error counters and damaged files',
        '  zpool clear tank           reset the error counters',
      ].join('\n'),
    )
    term.setSuggestions(['zpool status -v', 'zpool scrub tank', 'zpool clear tank', 'cat /tank/home/cat.png'])

    // --------------------------------------------------------------- script
    paint()
    await ctx.fly(v3(0, 12.5, 22.5), v3(0, 2.4, 1.4), 2)
    ctx.objectives([
      { id: 'heal', text: 'Read a file with a damaged copy' },
      { id: 'raid', text: 'See what hardware RAID would do' },
      { id: 'scrub', text: 'Scrub the pool' },
      { id: 'storm', text: `Survive a ${STORM_SECONDS}-second cosmic storm with no lost blocks` },
    ])
    ctx.unlock('mirror', 'bitrot')

    await ctx.next(
      'Your pool is now a **two-disk mirror**. The mint cubes up top are the blocks of six files; every one has a copy on `sda` (left) and `sdb` (right).',
    )
    const target = blocks.find((b) => b.file === 'cat.png' && b.index === 2)!
    await ctx.next('Let\'s give `sda` some bad luck.', 'Cosmic ray!')
    await strike(target, 0)
    await ctx.next(
      'One copy of cat.png\'s block 2 is now damaged. In real life you couldn\'t see this; the disk reports nothing wrong. Let\'s read the file.',
      'Read cat.png',
    )
    await readFile('cat.png', new Map([[2, 0]]))
    ctx.check('heal')
    ctx.unlock('selfheal', 'zpool-status')
    term.echo('zpool status')
    term.print(statusText())
    await ctx.next(
      'Watch that again in your head: ZFS read block 2 from `sda`, the checksum failed, so it read `sdb`, which matched. It handed the app the good data and **rewrote the bad copy on sda**. The app never knew. `zpool status` shows it as a CKSUM error on sda.',
    )

    // Hardware RAID comparison
    mode = 'raid'
    paint()
    const victim2 = blocks.find((b) => b.file === 'cat.png' && b.index === 1)!
    await ctx.next(
      'Now let\'s pretend this is a **hardware RAID-1** card instead of ZFS. It mirrors blocks too, but it keeps no checksums.',
      'Cosmic ray!',
    )
    await strike(victim2, 1)
    await ctx.next('Same kind of damage, this time on sdb. Read the file again.', 'Read cat.png')
    await readFile('cat.png', new Map([[1, 1]]))
    ctx.check('raid')
    await ctx.next(
      'No error, wrong picture. The controller read sdb, saw nothing wrong, and handed back garbage. Even if it read both sides, it couldn\'t tell which one was right. During a rebuild it might copy the bad one over the good one.',
    )
    mode = 'zfs'
    paint()
    hud.closeInspect()

    // Scrub
    const others = blocks.filter((b) => b !== victim2)
    for (const lb of [others[3], others[8], others[10]]) await strike(lb, lb.slot % 2)
    interactive = true
    ctx.unlock('scrub')
    hud.setActions([{ id: 'scrub', label: 'Scrub', cmd: 'zpool scrub tank', kind: 'primary', glow: true, onClick: () => void scrub().catch(() => {}) }])
    ctx.say(
      'Back to ZFS. Several copies are damaged now, in files nobody is reading. If the other copy of any of them goes bad too, that block is gone. A [[scrub]] reads **everything**. Press **Scrub** (or type `zpool scrub tank`).',
    )
    await ctx.until(() => lastScan !== 'none requested' && !scrubbing)
    hud.updateAction('scrub', { glow: false })
    ctx.check('scrub')
    term.echo('zpool status')
    term.print(statusText())
    await ctx.next('Every damaged copy repaired, with no file ever read. Scrubs run in the background at low priority; many admins schedule one a month.')

    // Storm
    hud.info(panel)
    ctx.unlock('zpool-clear')
    term.echo('zpool clear tank')
    cksumErrs[0] = cksumErrs[1] = 0
    paint()
    for (;;) {
      await ctx.next(
        `Now a cosmic storm: rays will hit for **${STORM_SECONDS} seconds**, faster and faster. If both copies of a block get hit, it's lost. **Click a red copy** to make ZFS read and repair it, or press **Scrub** to sweep everything (it needs 8 seconds to recharge). We can see the damage; real admins can't, which is why they scrub on a schedule.`,
        'Start the storm',
      )
      for (const lb of blocks) {
        lb.copies = [new Uint8Array(lb.data), new Uint8Array(lb.data)]
        lb.badSince = [null, null]
        lb.lost = false
      }
      paint()
      storm.running = true
      storm.left = STORM_SECONDS
      storm.nextRay = 1
      storm.rays = 0
      scrubCooldown = 0
      ctx.say('Storm incoming! Click red copies to heal them. Scrub when it gets busy.')
      await ctx.until(() => !storm.running)
      await ctx.sleep(0.8)
      const lost = blocks.filter((b) => b.lost)
      term.echo('zpool status -v')
      term.print(statusText(true))
      if (lost.length === 0) break
      await ctx.next(
        `${lost.length} block${lost.length > 1 ? 's' : ''} lost both copies. \`zpool status -v\` lists the damaged file${new Set(lost.map((b) => b.file)).size > 1 ? 's' : ''} under **permanent errors**: those need restoring from backup. Want to try again?`,
        'Try again',
      )
    }
    ctx.check('storm')
    await ctx.next(
      `You weathered ${storm.rays} cosmic rays without losing a block. Redundancy plus checksums gave ZFS a second copy, and the knowledge of which copy was right.`,
    )
    await ctx.next(
      'One more trick: even a single-disk pool keeps two or three copies of every metadata block ([[ditto|ditto blocks]]), and setting `copies=2` on a dataset does the same for your files. That protects against bad sectors, though not against the whole disk dying.',
      'Take the checkpoint',
    )
    await ctx.finish()
  },
}

