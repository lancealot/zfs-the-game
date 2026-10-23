import type { ChapterDef, Ctx } from './types'
import { C, cosmicRay, v3 } from '../engine/kit'
import { h } from '../ui/dom'
import { CowPool, type Blk, textBytes } from '../zfs/blocktree'
import { fletcher4, cksumEqual, cksumShort } from '../zfs/checksum'
import { TreeView } from '../scenes/treeView'
import { describeBlock, describeUber, zdbUberText } from '../scenes/inspect'
import { catBlocks, drawPixels, NOTES, bytesToText } from '../content/files'
import { formatStatus } from '../zfs/status'

const DS = 'tank/home'

export const chapter2: ChapterDef = {
  id: 'tree',
  num: 2,
  title: 'The Block Tree',
  tagline: 'Follow a read from the uberblock down to your data, and see why parents hold their children\'s checksums.',
  tags: ['uberblock', 'blkptr', 'checksum', 'Merkle tree'],
  summary: [
    'Everything hangs off the [[uberblock]]: MOS → object set → dnodes → indirect blocks → data.',
    'A [[blkptr|block pointer]] holds its child\'s address ([[dva|DVA]]), sizes, birth txg and checksum.',
    'Parents hold their children\'s checksums (a [[merkle|Merkle tree]]), so ZFS catches corruption and misdirected writes.',
    'Even without redundancy, ZFS detects damage and refuses to return bad data.',
  ],
  quiz: [
    {
      q: 'Where does ZFS keep the checksum of a data block?',
      options: [
        'In the block pointer held by the block\'s parent',
        'In a header at the start of the data block itself',
        'In a separate checksum file at the root of the dataset',
        'Only in the uberblock',
      ],
      answer: 0,
      explain: 'Every block pointer carries the checksum of the block it points to. Chained all the way up, that makes a Merkle tree rooted at the uberblock.',
    },
    {
      q: 'A disk writes a block to the wrong place. The bytes there now match their own checksum. Does ZFS notice?',
      options: [
        'Yes: the parent\'s block pointer expects a different checksum',
        'No: the checksum matches, so the data looks valid',
        'Only if the pool uses sha256',
        'Only when the next scrub runs',
      ],
      answer: 0,
      explain: 'A checksum stored next to its data travels with it and still "matches". ZFS compares against the checksum the parent recorded, so a misdirected write fails on the very next read.',
    },
    {
      q: 'What does a DVA tell ZFS?',
      options: ['Which vdev and offset a block lives at', 'The block\'s checksum', 'When the block was written', 'Which file the block belongs to'],
      answer: 0,
      explain: 'A Data Virtual Address is <vdev : offset : allocated size>. Block pointers can carry up to three of them for ditto copies.',
    },
    {
      q: 'A block pointer shows `size=20000L/6000P lz4`. What does that mean?',
      options: [
        'LZ4 shrank the block from 128 KiB to 24 KiB on disk',
        'The block is 24% full',
        'It is stored on two different vdevs',
        '128 KiB are on disk and 24 KiB are cached in RAM',
      ],
      answer: 0,
      explain: 'L is the logical size (0x20000 = 128 KiB) and P the physical size after compression (0x6000 = 24 KiB).',
    },
  ],

  async run(ctx: Ctx) {
    const { stage, hud, term, sound, scope } = ctx
    stage.camera.position.set(0, 14, 30)
    stage.controls.target.set(0, 6, 0)

    // A pool with a little history, so blocks are scattered across the disk.
    const pool = new CowPool(
      [
        {
          name: DS,
          files: [
            { name: 'cat.png', blocks: catBlocks(), birth: 1037 },
            { name: 'notes.txt', blocks: [textBytes('draft')], compressible: true, birth: 1036 },
          ],
        },
      ],
      { slots: 48, txg: 1036 },
    )
    const drafts = ['TODO: scrub monthly.', 'TODO: scrub the pool monthly. Buy disks.']
    for (const d of drafts) {
      pool.stageWrite(DS, 'notes.txt', 0, textBytes(d))
      pool.sync()
    }
    pool.stageWrite(DS, 'notes.txt', 0, NOTES)
    pool.sync()

    const tree = new TreeView(stage, scope, pool, { dataset: DS, cols: 12, rows: 4 })
    const cat = () => pool.fileBlocks(DS, 'cat.png')

    const chips = (extra = '') =>
      hud.stats([
        { k: 'txg', v: String(pool.txg) },
        { k: 'pool', v: extra || 'tank ONLINE', kind: extra ? 'bad' : 'ok', narrowHide: true },
      ])
    chips()

    // -------------------------------------------------------------- helpers
    const imageBox = (title: string) => {
      const canvas = h('canvas', { width: 16, height: 16, 'aria-label': 'cat.png as read from disk' }) as HTMLCanvasElement
      const blocks = cat().map((b) => (pool.verify(b) ? pool.media[b.slot] : null))
      drawPixels(canvas, blocks)
      const bad = blocks.filter((b) => !b).length
      return h(
        'div',
        { class: 'pixel-file' },
        canvas,
        h(
          'div',
          null,
          h('div', { class: 'mono', style: { color: 'var(--fg)' } }, title),
          h('div', { class: 'note', style: { marginTop: '4px' } }, bad ? `${bad} block${bad > 1 ? 's' : ''} failed verification: read returned EIO.` : 'All 4 blocks verified against their parent checksums.'),
        ),
      )
    }

    const inspectBlock = (b: Blk, eyebrow = 'Block pointer') => {
      const title =
        b.kind === 'data'
          ? `${b.meta.file}${b.meta.index !== undefined && b.meta.file === 'cat.png' ? ` · block ${b.meta.index}` : ''}`
          : b.kind === 'indirect'
            ? `L1 indirect · ${b.meta.file}`
            : b.kind === 'dnode'
              ? 'dnode block'
              : b.kind === 'objset'
                ? `object set ${b.meta.dataset}`
                : 'MOS'
      hud.inspect({ eyebrow, title, body: describeBlock(pool, b) })
    }

    const checkRow = (b: Blk) => {
      const onDisk = pool.media[b.slot]!
      const got = fletcher4(onDisk)
      const ok = cksumEqual(got, b.cksum)
      return h(
        'dl',
        { class: 'kv', style: { marginTop: '10px' } },
        h('dt', null, 'parent expects'),
        h('dd', null, `${cksumShort(b.cksum)}…`),
        h('dt', null, 'disk returned'),
        h('dd', { style: { color: ok ? 'var(--mint)' : 'var(--red)' } }, `${cksumShort(got)}… ${ok ? '✓ match' : '✗ MISMATCH'}`),
      )
    }

    let phase: 'intro' | 'uber' | 'path' | 'free' | 'busy' = 'intro'
    let sawUber = false
    let pathStep = 0
    let path: Blk[] = []
    let sawNotes = false
    let sawCat = false

    tree.onPickUber = () => {
      sound.click()
      hud.inspect({ eyebrow: 'Vdev label', title: `Uberblock · txg ${pool.txg}`, body: describeUber(pool) })
      sawUber = true
    }

    tree.onPick = (b) => {
      sound.click()
      if (phase === 'path') {
        const want = path[pathStep]
        const isLast = pathStep === path.length - 1
        const ok = b === want || (isLast && b.kind === 'data' && b.meta.file === 'cat.png')
        if (!ok) {
          hud.toast(`Not on the path. ZFS needs the ${stepName(want)} next.`, 'bad')
          sound.bad()
          return
        }
        const from = pathStep === 0 ? null : path[pathStep - 1]
        pathStep++
        tree.hint(isLast ? null : path[pathStep])
        void tree.trace(from ? [from, b] : [b], C.uber, 0.6).catch(() => {})
        tree.flash(b, C.ok)
        hud.inspect({ eyebrow: `Step ${pathStep} of ${path.length} · verified`, title: stepTitle(b), body: h('div', null, describeBlock(pool, b, checkRow(b))) })
        return
      }
      if (b.kind === 'data' && b.meta.file === 'notes.txt') sawNotes = true
      if (b.kind === 'data' && b.meta.file === 'cat.png') sawCat = true
      inspectBlock(b)
    }

    const stepName = (b: Blk) =>
      b.kind === 'mos' ? 'MOS' : b.kind === 'objset' ? 'object set (tank/home)' : b.kind === 'dnode' ? 'dnode block' : b.kind === 'indirect' ? 'L1 indirect block of cat.png' : 'an L0 data block of cat.png'
    const stepTitle = (b: Blk) => (b.kind === 'data' ? `cat.png · block ${b.meta.index}` : stepName(b))

    /** Reads cat.png the way ZFS does, verifying every block against its parent. */
    async function readCat(): Promise<boolean> {
      term.echo('cat /tank/home/cat.png > /dev/null')
      let ok = true
      const l1 = pool.fileRoot(DS, 'cat.png')
      await tree.trace([pool.mos, pool.dataset(DS), pool.dnodeBlock(DS), l1], C.uber, 0.9)
      for (const b of cat()) {
        await tree.trace([l1, b], C.uber, 0.35)
        sound.read()
        if (pool.verify(b)) tree.flash(b, C.ok)
        else {
          ok = false
          tree.corrupt.add(b)
          tree.restyle()
          tree.flash(b, C.corrupt)
          sound.bad()
        }
      }
      if (!ok) term.print('cat: /tank/home/cat.png: Input/output error', 'err')
      hud.inspect({ eyebrow: 'Read result', title: 'cat.png', body: imageBox('/tank/home/cat.png') })
      return ok
    }

    function statusText() {
      const damaged = cat().some((b) => !pool.verify(b) && tree.corrupt.has(b))
      return formatStatus({
        pool: 'tank',
        state: 'ONLINE',
        status: damaged ? 'One or more devices has experienced an error resulting in data\ncorruption.  Applications may be affected.' : undefined,
        action: damaged ? 'Restore the file in question if possible.  Otherwise restore the\nentire pool from backup.' : undefined,
        see: damaged ? 'https://openzfs.github.io/openzfs-docs/msg/ZFS-8000-8A' : undefined,
        vdevs: [{ name: 'sda', state: 'ONLINE', cksum: damaged ? 1 : 0 }],
        poolCounters: { read: 0, write: 0, cksum: damaged ? 1 : 0 },
        errors: damaged ? 'Permanent errors have been detected in the following files:\n\n        /tank/home/cat.png' : undefined,
      })
    }

    // ------------------------------------------------------------- terminal
    term.setHandler(
      (argv, line) => {
        const [cmd, a1] = argv
        if (cmd === 'zdb' && a1 === '-u') {
          term.print(zdbUberText(pool))
          return true
        }
        if (cmd === 'zdb') {
          term.print('In this chapter, click any block to see its zdb-style block pointer. Try: zdb -u tank', 'warn')
          return true
        }
        if (cmd === 'ls') {
          term.print('-rw-r--r--  1 root root  512K cat.png\n-rw-r--r--  1 root root  128K notes.txt')
          return true
        }
        if (cmd === 'cat') {
          const f = (a1 ?? '').split('/').pop()
          if (f === 'notes.txt') {
            const b = pool.fileBlocks(DS, 'notes.txt')[0]
            if (!pool.verify(b)) term.print('cat: notes.txt: Input/output error', 'err')
            else term.print(bytesToText(pool.media[b.slot]!))
          } else if (f === 'cat.png') {
            if (phase === 'busy') term.print('busy, try again in a moment', 'warn')
            else void readCat().catch(() => {})
          } else term.print(`cat: ${a1 ?? ''}: No such file or directory`, 'err')
          return true
        }
        if (cmd === 'zpool' && a1 === 'status') {
          term.print(statusText())
          return true
        }
        if (cmd === 'zfs' && a1 === 'get' && line.includes('compressratio')) {
          term.print(`NAME       PROPERTY       VALUE  SOURCE\n${DS}  compressratio  1.21x  -`)
          return true
        }
        return false
      },
      [
        'Commands in this chapter:',
        '  zdb -u tank                 print the active uberblock',
        '  cat /tank/home/notes.txt    read a file (verifies every block)',
        '  cat /tank/home/cat.png',
        '  zpool status -v             health and damaged files',
        '  zfs get compressratio tank/home',
        '  ls                          list the dataset',
      ].join('\n'),
    )
    term.setSuggestions(['zdb -u tank', 'cat notes.txt', 'zpool status -v', 'zfs get compressratio tank/home'])

    // --------------------------------------------------------------- script
    await ctx.fly(v3(0, 10.5, 25), v3(0, 5.4, 1.6), 2)
    ctx.objectives([
      { id: 'uber', text: 'Inspect the [[uberblock]]' },
      { id: 'read', text: 'Read cat.png, block by block, from the root' },
      { id: 'notes', text: 'Find out where notes.txt lives on disk' },
      { id: 'rot', text: 'Corrupt a block and read the file again' },
      { id: 'misdirect', text: 'Catch a misdirected write' },
    ])

    await ctx.next(
      'This is the inside of a pool. Floating above is the block tree of the dataset `tank/home`. The platter below is the disk, where each block physically lives. Hover a block to see where it sits.',
    )
    await ctx.next(
      'The colors run from the root down: gold [[uberblock]], coral [[mos|MOS]], rose [[objset|object set]], violet [[dnode]] block, blue [[indirect|indirect block]], mint data. Every line is a [[blkptr|block pointer]]: a parent recording where its child lives.',
    )
    ctx.unlock('blkptr', 'mos', 'objset', 'dnode', 'indirect')

    phase = 'uber'
    ctx.say('Everything starts at the top. **Click the gold uberblock.**')
    await ctx.until(() => sawUber)
    ctx.check('uber')
    ctx.unlock('uberblock', 'vdev-label')
    await ctx.next(
      'The uberblock lives in the disk\'s [[vdev-label|labels]], not in the tree. Its magic number is `0x00bab10c` ("oo-ba-bloc"). It records the txg it was written in, and one block pointer: the address and checksum of the MOS.',
    )

    // Read path
    path = pool.pathTo(DS, 'cat.png', 0)
    pathStep = 0
    phase = 'path'
    hud.closeInspect()
    tree.hint(path[0])
    ctx.say(
      'Now read `cat.png` the way ZFS does: start at the root and follow pointers. **Click the MOS**, then the object set, the dnode block, cat.png\'s L1, and finally one of its data blocks. The pulsing block is next.',
    )
    await ctx.until(() => pathStep >= path.length)
    phase = 'busy'
    ctx.check('read')
    ctx.unlock('checksum', 'merkle')
    await ctx.sleep(0.6)
    await ctx.next(
      'At every hop, ZFS compared what the disk returned with the checksum stored **in the parent\'s block pointer**. Only a match lets the read continue. The uberblock vouches for the MOS, the MOS for the object set, and so on down: a [[merkle|Merkle tree]].',
    )
    await readCat()
    await ctx.next('Reading the whole file repeats that for all four data blocks. Here\'s the picture, every block verified.')

    // notes.txt location
    phase = 'free'
    hud.closeInspect()
    tree.hint(pool.fileBlocks(DS, 'notes.txt')[0])
    ctx.say('Small files are simpler. **Click notes.txt** (the lone mint block on the right) to see its block pointer.')
    await ctx.until(() => sawNotes)
    tree.hint(null)
    ctx.check('notes')
    ctx.unlock('dva', 'compression', 'recordsize')
    await ctx.next(
      'notes.txt fits in one block, so its dnode points straight at the data, with no indirect block. The [[dva|DVA]] `<0:offset:size>` says: vdev 0, this byte offset. The hover line shows the matching slot on the platter.',
    )
    await ctx.next(
      'Look at the sizes: `lsize` 128 KiB but `psize` only 24 KiB. Text compresses well, so [[compression|LZ4]] saved 80%. Click a cat.png block to compare: its PNG data is already compressed, so ZFS stores it uncompressed.',
    )
    await ctx.until(() => sawCat)
    await ctx.sleep(0.8)
    ctx.unlock('embedded')

    // Bit rot
    phase = 'busy'
    hud.closeInspect()
    const victim = cat()[2]
    await ctx.next('Now let\'s break something. Disks are not perfect; a stray cosmic ray or a tired sector can flip bits.', 'Unleash a cosmic ray')
    await cosmicRay(scope, tree.group, tree.slotPos(victim.slot).setY(0.4))
    sound.zap()
    pool.corrupt(victim.slot)
    tree.markSlot(victim.slot, C.corrupt)
    chips()
    await ctx.next(
      'One sector of cat.png\'s block 2 just changed on disk. We can see it glowing red, but ZFS can\'t yet. No drive error was reported: this is [[bitrot|silent corruption]]. Let\'s read the file again.',
      'Read cat.png',
    )
    const ok = await readCat()
    void ok
    ctx.check('rot')
    chips('tank errors')
    term.echo('zpool status -v')
    term.print(statusText())
    ctx.unlock('bitrot')
    await ctx.next(
      'Caught it. Block 2 didn\'t match the checksum in its L1 parent, so ZFS returned an I/O error instead of garbage. This pool is a single disk, so there\'s no good copy to repair from. `zpool status -v` names the damaged file. In chapter 4 you\'ll watch redundancy heal this automatically.',
    )
    pool.repair(victim)
    tree.corrupt.delete(victim)
    tree.refresh(false)
    chips()
    hud.closeInspect()

    // Misdirected write
    const src = cat()[1]
    const dst = cat()[3]
    await ctx.next(
      'One more experiment. Why keep checksums in the parent instead of next to the data? Suppose the disk firmware has a bug and writes block 1\'s data into **block 3\'s** slot.',
      'Misdirect a write',
    )
    sound.write()
    await tree.trace([src], C.zil, 0.4).catch(() => {})
    pool.media[dst.slot] = new Uint8Array(pool.media[src.slot]!)
    tree.markSlot(dst.slot, C.zil)
    const selfOk = cksumEqual(fletcher4(pool.media[dst.slot]!), src.cksum)
    hud.inspect({
      eyebrow: 'Two ways to check',
      title: 'Slot of block 3',
      body: h(
        'div',
        null,
        h('p', { class: 'note', style: { marginTop: '0' } }, 'The slot now holds block 1\'s bytes. If each block carried its own checksum, the check would compare the data with itself:'),
        h(
          'dl',
          { class: 'kv' },
          h('dt', null, 'self-checksum'),
          h('dd', { style: { color: 'var(--amber)' } }, selfOk ? '✓ matches (fooled!)' : '✗'),
          h('dt', null, 'ZFS (parent L1)'),
          h('dd', { style: { color: 'var(--red)' } }, pool.verify(dst) ? '✓' : '✗ expected block 3, got something else'),
        ),
        h('p', { class: 'note' }, 'The L1 recorded block 3\'s checksum, so the stale or misplaced data fails no matter how self-consistent it looks.'),
      ),
    })
    ctx.check('misdirect')
    await ctx.next(
      'A checksum stored with the data travels with the data. Misdirected writes and phantom writes (writes the disk claims but never does) slip right past it. Because each parent vouches for its children, ZFS catches both. Trust the uberblock, and you can verify the whole pool.',
    )
    pool.repair(dst)
    tree.refresh(false)
    hud.closeInspect()
    ctx.unlock('ditto')
    await ctx.next(
      'One last detail: click a metadata block and you\'ll see **DVA[1]** (and DVA[2] on the MOS). Those are [[ditto|ditto blocks]], extra copies ZFS keeps of metadata even on one disk. Losing one L1 would cost a whole file; losing the MOS, the pool.',
      'Take the checkpoint',
    )
    await ctx.finish()
  },
}
