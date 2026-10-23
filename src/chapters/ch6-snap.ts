import type { ChapterDef, Ctx } from './types'
import { C, v3 } from '../engine/kit'
import { h } from '../ui/dom'
import { CowPool, noiseBytes, textBytes, type Blk, type Snapshot } from '../zfs/blocktree'
import { TreeView } from '../scenes/treeView'
import { describeBlock, describeUber } from '../scenes/inspect'
import { catBlocks, CAT_EDITS, editBytes, drawPixels, NOTES, BUDGET } from '../content/files'
import { fmtSize } from '../zfs/units'

const DS = 'tank/home'
const CLONE = 'tank/test'

export const chapter6: ChapterDef = {
  id: 'snapshots',
  num: 6,
  title: 'Snapshots',
  tagline: 'Freeze time for free, decide which blocks live or die by their birth txg, and roll back a ransomware attack.',
  tags: ['snapshot', 'birth txg', 'rollback', 'clone'],
  summary: [
    'A [[snapshot]] is instant and costs nothing at first: it just keeps an old root alive.',
    'Snapshot space is made of blocks the live data replaced but a snapshot still references.',
    'The [[birth|birth txg]] rule decides free-now vs. [[deadlist]] with a single comparison.',
    '[[rollback|Rollback]], [[clone|clones]] and incremental [[send]] all fall out of the same block tree.',
  ],
  quiz: [
    {
      q: 'How long does it take to snapshot a 10 TB dataset?',
      options: [
        'About as long as a 1 KB one: a snapshot just keeps the old root',
        'Hours, because the data has to be copied',
        'A few minutes per terabyte',
        'It depends on how many files there are',
      ],
      answer: 0,
      explain: 'Taking a snapshot records the dataset\'s current root block pointer in the MOS. No data is read or copied.',
    },
    {
      q: 'The live dataset frees a block born in txg 50. The latest snapshot was taken in txg 80. What happens?',
      options: [
        'It goes on the deadlist, because the snapshot still references it',
        'It is freed immediately',
        'The snapshot is destroyed to make room',
        'ZFS scans every snapshot to find out',
      ],
      answer: 0,
      explain: 'Born at or before the snapshot means the snapshot can see it. No scan needed: one comparison of birth txgs.',
    },
    {
      q: 'Same pool, but the freed block was born in txg 95, after that snapshot. What happens?',
      options: ['It is freed immediately: no snapshot can reference it', 'It goes on the deadlist', 'It becomes part of the snapshot', 'It is kept until the next scrub'],
      answer: 0,
      explain: 'A block born after the newest snapshot was never visible to any snapshot, so its space comes back right away.',
    },
    {
      q: 'What does `zfs send -i @mon @tue` transfer?',
      options: [
        'Only blocks born after @mon, found by skipping older subtrees',
        'The whole dataset as of @tue',
        'Every file whose name changed',
        'The deadlist of @tue',
      ],
      answer: 0,
      explain: 'Any subtree whose block pointer has a birth txg at or before @mon can be skipped entirely, so ZFS finds the changes without comparing contents.',
    },
  ],

  async run(ctx: Ctx) {
    const { stage, hud, term, sound, scope } = ctx
    stage.camera.position.set(0, 14, 32)
    stage.controls.target.set(0, 5, 0)

    const original = catBlocks()
    const pool = new CowPool(
      [
        {
          name: DS,
          files: [
            { name: 'cat.png', blocks: original.map((b) => new Uint8Array(b)), birth: 3001 },
            { name: 'notes.txt', blocks: [textBytes('draft')], compressible: true, birth: 3000 },
            { name: 'budget.csv', blocks: [BUDGET], compressible: true, birth: 3003 },
            { name: 'song.mp3', blocks: [noiseBytes(61), noiseBytes(62)], birth: 3005 },
          ],
        },
      ],
      { slots: 60, txg: 3000 },
    )
    pool.stageWrite(DS, 'notes.txt', 0, NOTES)
    pool.sync()

    const tree = new TreeView(stage, scope, pool, { dataset: DS, cols: 15, rows: 4, spacing: 1.25 })

    // ------------------------------------------------------------- helpers
    let busy = false
    const sizeOf = (bs: Iterable<Blk>) => [...bs].reduce((n, b) => n + b.psize, 0)
    const refer = (root: Blk) => sizeOf(pool.reachable([root]))
    const usedLive = () => sizeOf(pool.reachable([pool.dataset(DS)]))

    function tagSnapshots() {
      tree.tags.clear()
      const byRoot = new Map<Blk, string[]>()
      for (const s of pool.snapshots) byRoot.set(s.root, [...(byRoot.get(s.root) ?? []), `@${s.name}`])
      for (const [b, names] of byRoot) tree.tags.set(b, names.join(' '))
      if (pool.datasets.has(CLONE)) {
        const c = pool.dataset(CLONE)
        // Until it diverges, the clone's root is the snapshot's own object set.
        if (c.meta.dataset !== CLONE) tree.tags.set(c, `${tree.tags.get(c) ?? ''} ${CLONE}`.trim())
      }
    }

    const listEl = h('div')
    const picCanvas = h('canvas', { width: 16, height: 16, 'aria-label': 'cat.png in the live dataset' }) as HTMLCanvasElement
    picCanvas.style.width = '72px'
    picCanvas.style.height = '72px'
    const picNote = h('div', { class: 'note', style: { marginTop: '0' } })
    hud.info(h('div', null, h('h3', null, 'Datasets & snapshots'), listEl, h('div', { class: 'pixel-file' }, picCanvas, picNote)))

    function renderPanel() {
      tagSnapshots()
      const rows: Array<[string, string, string]> = [[DS, fmtSize(usedLive()), fmtSize(usedLive())]]
      for (const s of pool.snapshots) rows.push([`${DS}@${s.name}`, fmtSize(sizeOf(pool.uniqueTo(s))), fmtSize(refer(s.root))])
      if (pool.datasets.has(CLONE)) rows.push([CLONE, fmtSize(sizeOf(uniqueToClone())), fmtSize(refer(pool.dataset(CLONE)))])
      listEl.replaceChildren(
        h(
          'dl',
          { class: 'kv', style: { gridTemplateColumns: 'minmax(0,1fr) auto auto' } },
          h('dt', null, 'NAME'),
          h('dt', null, 'USED'),
          h('dt', null, 'REFER'),
          ...rows.flatMap(([n, u, r]) => [h('dd', null, n), h('dd', { style: { textAlign: 'right' } }, u), h('dd', { style: { textAlign: 'right' } }, r)]),
        ),
      )
      const names = pool.fileNames(DS)
      if (names.includes('cat.png')) {
        drawPixels(picCanvas, pool.fileBlocks(DS, 'cat.png').map((b) => b.data))
        picNote.textContent = `/tank/home/cat.png (live) · files: ${names.join(', ')}`
      } else picNote.textContent = 'cat.png is gone from the live dataset.'
      hud.stats([
        { k: 'txg', v: String(pool.txg) },
        { k: 'snapshots', v: String(pool.snapshots.length), narrowHide: true },
      ])
    }

    function uniqueToClone(): Blk[] {
      const others = pool.reachable([pool.dataset(DS), ...pool.snapshots.map((s) => s.root)])
      return [...pool.reachable([pool.dataset(CLONE)])].filter((b) => !others.has(b))
    }

    /** Syncs whatever is pending, animating new blocks rising from the disk. */
    async function sync(beforeCommit?: (plan: NonNullable<ReturnType<CowPool['beginSync']>>) => Promise<void>) {
      busy = true
      try {
        const plan = pool.beginSync()
        if (!plan) return null
        tree.hidden = new Set(plan.written)
        tree.setPlan(plan)
        if (beforeCommit) await beforeCommit(plan)
        for (const b of plan.written) {
          await tree.rise(b, 0.16)
          sound.write()
        }
        const res = pool.commitSync(plan)
        tree.setPlan(null)
        sound.commit()
        renderPanel()
        tree.refresh()
        await tree.commit()
        return res
      } finally {
        busy = false
      }
    }

    let editIdx = 0
    async function editCat(index?: number) {
      if (busy) return
      const e = CAT_EDITS[index ?? editIdx++ % CAT_EDITS.length]
      const cur = pool.contents(DS, 'cat.png', e.block)
      const next = sameBytes(cur, original[e.block]) ? editBytes(e.rows) : original[e.block]
      pool.stageWrite(DS, 'cat.png', e.block, next)
      term.echo(`# app rewrites cat.png block ${e.block}`)
      await sync()
    }

    async function editNotes(ds = DS) {
      if (busy) return
      pool.stageWrite(ds, 'notes.txt', 0, textBytes(`notes v${pool.openTxg}: remember to snapshot!`))
      term.echo(`echo "…" > /${ds}/notes.txt`)
      await sync()
    }

    async function snapshot(name: string, echo = true) {
      if (busy) return
      if (pool.snapshots.some((s) => s.name === name)) {
        term.print(`cannot create snapshot '${DS}@${name}': dataset already exists`, 'err')
        return
      }
      if (echo) term.echo(`zfs snapshot ${DS}@${name}`)
      pool.snapshot(DS, name)
      await sync()
      sound.chime()
    }

    async function rollback(name: string, echo = true) {
      if (busy) return false
      const s = pool.snapshots.find((x) => x.name === name)
      if (!s) {
        term.print(`cannot open '${DS}@${name}': dataset does not exist`, 'err')
        return false
      }
      const newer = pool.snapshots.filter((x) => x.txg > s.txg)
      if (echo) term.echo(`zfs rollback ${DS}@${name}`)
      if (newer.length) {
        term.print(`cannot rollback to '${DS}@${name}': more recent snapshots or bookmarks exist\nuse '-r' to force deletion of the following snapshots and bookmarks:\n${newer.map((x) => `${DS}@${x.name}`).join('\n')}`, 'err')
        return false
      }
      pool.rollback(DS, name)
      const res = await sync()
      term.print(`# rollback freed ${res?.freed.length ?? 0} blocks born after txg ${s.txg}`, 'dim')
      return true
    }

    function listSnapshots() {
      const lines = ['NAME                 USED  AVAIL  REFER  MOUNTPOINT']
      for (const s of pool.snapshots) lines.push(`${`${DS}@${s.name}`.padEnd(19)} ${fmtSize(sizeOf(pool.uniqueTo(s))).padStart(5)}      -  ${fmtSize(refer(s.root)).padStart(5)}  -`)
      if (!pool.snapshots.length) lines.splice(0, 1, 'no datasets available')
      term.print(lines.join('\n'))
    }

    function diff(snapName: string) {
      const s = pool.snapshots.find((x) => x.name === snapName)
      if (!s) return term.print(`Unable to obtain diffs: snapshot '${snapName}' does not exist`, 'err')
      const then = new Set(pool.fileNames(DS).length ? s.root.children[0].children.map((b) => b.meta.file!) : [])
      const now = pool.fileNames(DS)
      const out: string[] = []
      for (const f of now) {
        if (!then.has(f)) out.push(`+\t/tank/home/${f}`)
        else {
          const a = pool.fileRoot(DS, f, s.root)
          const b = pool.fileRoot(DS, f)
          if (a !== b) out.push(`M\t/tank/home/${f}`)
        }
      }
      for (const f of then) if (!now.includes(f)) out.push(`-\t/tank/home/${f}`)
      term.print(out.length ? out.join('\n') : '(no changes)')
    }

    tree.onPick = (b) => {
      sound.click()
      hud.inspect({ eyebrow: 'Block pointer', title: `${b.kind === 'data' ? `${b.meta.file} · L0` : b.kind} · birth ${b.birth}`, body: describeBlock(pool, b) })
    }
    tree.onPickUber = () => hud.inspect({ eyebrow: 'Vdev label', title: `Uberblock · txg ${pool.txg}`, body: describeUber(pool) })

    // ------------------------------------------------------------ terminal
    let allowed = new Set<string>(['list', 'diff'])
    term.setHandler(
      async (argv) => {
        const [cmd, sub, ...rest] = argv
        if (cmd === 'ls' && (sub ?? '').includes('.zfs/snapshot')) {
          term.print(pool.snapshots.map((s) => s.name).join('  ') || '')
          return true
        }
        if (cmd !== 'zfs') return false
        const target = rest.filter((a) => !a.startsWith('-'))
        if (sub === 'list') {
          if (argv.includes('snapshot') || argv.includes('all')) listSnapshots()
          else term.print(`NAME        USED  AVAIL  REFER  MOUNTPOINT\n${DS}  ${fmtSize(usedLive()).padStart(5)}  3.51T  ${fmtSize(usedLive()).padStart(5)}  /${DS}${pool.datasets.has(CLONE) ? `\n${CLONE}  ${fmtSize(sizeOf(uniqueToClone())).padStart(5)}  3.51T  ${fmtSize(refer(pool.dataset(CLONE))).padStart(5)}  /${CLONE}` : ''}`)
          return true
        }
        if (sub === 'diff') {
          const name = (target[0] ?? '').split('@')[1]
          diff(name ?? '')
          return true
        }
        const gate = (op: string) => {
          if (allowed.has(op)) return true
          term.print(`Ditto: not yet! Follow along and we'll get to \`zfs ${op}\`.`, 'warn')
          return false
        }
        if (sub === 'snapshot') {
          if (!gate('snapshot')) return true
          const [ds, name] = (target[0] ?? '').split('@')
          if (ds !== DS || !name) term.print(`usage: zfs snapshot ${DS}@<name>`, 'err')
          else await snapshot(name, false)
          return true
        }
        if (sub === 'rollback') {
          if (!gate('rollback')) return true
          const [ds, name] = (target[0] ?? '').split('@')
          if (ds !== DS || !name) term.print(`usage: zfs rollback ${DS}@<snapshot>`, 'err')
          else if (rest.includes('-r')) {
            const s = pool.snapshots.find((x) => x.name === name)
            if (s) await rollbackForce(s)
            else term.print(`cannot open '${DS}@${name}': dataset does not exist`, 'err')
          } else await rollback(name, false)
          return true
        }
        if (sub === 'clone') {
          if (!gate('clone')) return true
          const [src, dst] = target
          const name = (src ?? '').split('@')[1]
          if (!name || !pool.snapshots.some((s) => s.name === name)) term.print(`cannot open '${src ?? ''}': dataset does not exist`, 'err')
          else if (dst !== CLONE) term.print(`In this lab, clone into ${CLONE}: zfs clone ${src} ${CLONE}`, 'warn')
          else if (pool.datasets.has(CLONE)) term.print(`cannot create '${CLONE}': dataset already exists`, 'err')
          else await clone(name, false)
          return true
        }
        if (sub === 'destroy') {
          if (!gate('destroy')) return true
          const [ds, name] = (target[0] ?? '').split('@')
          if (ds !== DS || !name || !pool.snapshots.some((s) => s.name === name)) term.print(`could not find any snapshots to destroy; check snapshot names.`, 'err')
          else if (pool.datasets.has(CLONE) && pool.dataset(CLONE) === pool.snapshots.find((s) => s.name === name)!.root)
            term.print(`cannot destroy '${DS}@${name}': snapshot has dependent clones\nuse '-R' to destroy the following datasets:\n${CLONE}`, 'err')
          else {
            const before = pool.usedSlots()
            pool.destroySnapshot(name)
            await sync()
            term.print(`# freed ${before - pool.usedSlots()} blocks that only @${name} was holding`, 'dim')
          }
          return true
        }
        return false
      },
      [
        'Commands in this chapter:',
        `  zfs snapshot ${DS}@friday`,
        '  zfs list -t snapshot',
        `  zfs diff ${DS}@monday`,
        `  zfs rollback ${DS}@<snapshot>`,
        `  zfs clone ${DS}@<snapshot> ${CLONE}`,
        `  zfs destroy ${DS}@<snapshot>`,
        '  ls /tank/home/.zfs/snapshot',
      ].join('\n'),
    )
    term.setSuggestions(['zfs list -t snapshot', `zfs diff ${DS}@monday`, 'ls /tank/home/.zfs/snapshot'])

    async function rollbackForce(s: Snapshot) {
      for (const x of pool.snapshots.filter((y) => y.txg > s.txg)) term.print(`# destroying ${DS}@${x.name}`, 'dim')
      pool.rollback(DS, s.name)
      await sync()
    }

    async function clone(name: string, echo = true) {
      if (echo) term.echo(`zfs clone ${DS}@${name} ${CLONE}`)
      pool.clone(name, CLONE)
      await sync()
    }

    // -------------------------------------------------------------- script
    renderPanel()
    await ctx.fly(v3(0, 10.5, 26), v3(0, 5.4, 1.6), 2)
    ctx.objectives([
      { id: 'snap', text: 'Take a [[snapshot]]' },
      { id: 'diverge', text: 'Change a file and see what the snapshot keeps' },
      { id: 'birth', text: 'Free or keep? Decide 4 blocks\' fate by birth txg' },
      { id: 'ransom', text: 'Recover from ransomware' },
      { id: 'clone', text: 'Make a writable [[clone]]' },
      { id: 'send', text: 'Find what an incremental send would transfer' },
    ])

    await ctx.next(
      'Snapshots are where [[cow|copy-on-write]] pays off. Here\'s `tank/home` with four files, and a bigger disk below. Let\'s freeze it in time.',
    )
    allowed = new Set(['list', 'diff', 'snapshot'])
    hud.setActions([{ id: 'snap', label: 'Snapshot @monday', cmd: `zfs snapshot ${DS}@monday`, kind: 'primary', glow: true, onClick: () => void snapshot('monday') }])
    ctx.say(`Press **Snapshot @monday**, or type \`zfs snapshot ${DS}@monday\`.`)
    await ctx.until(() => pool.snapshots.length >= 1 && !busy)
    hud.setActions([])
    ctx.check('snap')
    ctx.unlock('snapshot')
    await ctx.next(
      'Done, instantly. The only thing written was a new MOS recording "@monday = this object set". The snapshot shares every block with the live dataset, which is why its **USED** is basically zero.',
    )

    // Diverge
    hud.setActions([{ id: 'cat', label: 'Edit cat.png', cmd: 'rewrite one block', kind: 'primary', glow: true, onClick: () => void editCat(0) }])
    ctx.say('Now change something. Press **Edit cat.png**.')
    const snap0 = pool.snapshots[0]
    await ctx.until(() => pool.fileRoot(DS, 'cat.png') !== snap0.root.children[0].children.find((b) => b.meta.file === 'cat.png') && !busy)
    hud.setActions([])
    ctx.check('diverge')
    await ctx.next(
      'The live tree moved on: new data block, new L1, new dnode block, new object set. But **@monday still points at the old object set**, and through it at the old blocks. Those can\'t be freed, so they stay on disk, drawn faded and pushed back. That\'s snapshot space: @monday\'s USED just grew.',
    )

    // Birth txg game
    ctx.unlock('birth', 'deadlist')
    tree.setLabels('birth')
    await ctx.next(
      'How does ZFS decide, when the live data drops a block, whether some snapshot still needs it? It checks the block\'s [[birth|birth txg]], which I\'m now showing on every block. Born **at or before** the newest snapshot: a snapshot can see it, so it goes on the [[deadlist]]. Born **after**: nobody else can see it, so it\'s freed on the spot.',
    )
    let correct = 0
    const decisions: Array<{ label: string; change: () => void }> = [
      { label: 'rewrite cat.png block 1', change: () => pool.stageWrite(DS, 'cat.png', 1, editBytes(CAT_EDITS[1].rows)) },
      { label: 'rewrite cat.png block 1 again', change: () => pool.stageWrite(DS, 'cat.png', 1, original[1]) },
      { label: 'delete budget.csv', change: () => pool.deleteFile(DS, 'budget.csv') },
      { label: 'rewrite cat.png block 0', change: () => pool.stageWrite(DS, 'cat.png', 0, original[0]) },
    ]
    for (let i = 0; i < decisions.length; i++) {
      const d = decisions[i]
      d.change()
      term.echo(`# app: ${d.label}`)
      const latest = pool.latestSnapshot(DS)!
      await sync(async (plan) => {
        const newLive = pool.reachable([...plan.datasets.values()])
        const dropped = [...pool.reachable([pool.dataset(DS)])].filter((b) => b.kind === 'data' && !newLive.has(b))
        const victim = dropped[0]
        if (!victim) return
        tree.hint(victim)
        const answer = await ctx.choose(
          `Decision ${i + 1} of ${decisions.length}: the app wants to **${d.label}**. That drops the pulsing block, born in **txg ${victim.birth}**. The newest snapshot, @${latest.name}, was taken in **txg ${latest.txg}**. What should ZFS do with the old block?`,
          [
            { id: 'free', label: 'Free it now' },
            { id: 'dead', label: 'Deadlist it' },
          ],
        )
        tree.hint(null)
        const right = victim.birth > latest.txg ? 'free' : 'dead'
        if (answer === right) {
          correct++
          sound.ok()
          hud.toast(right === 'free' ? `Right: born after txg ${latest.txg}, no snapshot can see it.` : `Right: born at or before txg ${latest.txg}, @${latest.name} still needs it.`, 'ok', 3500)
        } else {
          sound.bad()
          hud.toast(right === 'free' ? `It's freed: txg ${victim.birth} is after the snapshot (txg ${latest.txg}).` : `It's deadlisted: txg ${victim.birth} ≤ ${latest.txg}, so @${latest.name} references it.`, 'bad', 4200)
        }
      })
      await ctx.sleep(0.5)
    }
    ctx.check('birth')
    await ctx.next(
      `${correct} of ${decisions.length} right. Notice: no reference counts, no scanning snapshots. Just one comparison per block, because copy-on-write guarantees an older snapshot can only reference blocks born before it was taken.`,
    )
    tree.setLabels('name')

    // Ransomware
    ctx.unlock('rollback')
    allowed = new Set(['list', 'diff', 'snapshot', 'rollback'])
    await snapshot('tuesday')
    term.print('# nightly snapshot job: created tank/home@tuesday', 'dim')
    await ctx.next('It\'s Tuesday night, and your snapshot job just took `@tuesday`. Now the bad news…', 'Uh oh')
    for (const f of pool.fileNames(DS)) {
      const n = pool.fileBlocks(DS, f).length
      for (let i = 0; i < n; i++) pool.stageWrite(DS, f, i, noiseBytes(900 + i + f.length * 7))
    }
    term.print('YOUR FILES HAVE BEEN ENCRYPTED. SEND 5 BTC TO RECOVER THEM.', 'err')
    sound.bad()
    await sync()
    hud.setActions([{ id: 'rb', label: 'Roll back to @tuesday', cmd: `zfs rollback ${DS}@tuesday`, kind: 'primary', glow: true, onClick: () => void rollback('tuesday') }])
    ctx.say(
      'Ransomware encrypted every file in the live dataset (look at the cat!). But snapshots are **read-only**: it couldn\'t touch @tuesday. Roll back with the button, or `zfs rollback tank/home@tuesday`.',
    )
    await ctx.until(() => !busy && pool.snapshots.some((s) => s.name === 'tuesday' && s.root === pool.dataset(DS)))
    hud.setActions([])
    ctx.check('ransom')
    await ctx.next(
      'Files restored in one txg. Rollback just pointed the dataset back at @tuesday\'s root, and every block born after @tuesday was freed. No copying, no backup restore. (A smart attacker with root could destroy snapshots too, which is why you also replicate them elsewhere.)',
    )

    // Clone
    ctx.unlock('clone')
    allowed = new Set(['list', 'diff', 'snapshot', 'rollback', 'clone', 'destroy'])
    hud.setActions([{ id: 'clone', label: `Clone @tuesday`, cmd: `zfs clone ${DS}@tuesday ${CLONE}`, kind: 'primary', glow: true, onClick: () => void clone('tuesday') }])
    ctx.say(`Snapshots are read-only, but you can make a writable copy from one: a [[clone]]. Press **Clone @tuesday**.`)
    await ctx.until(() => pool.datasets.has(CLONE) && !busy)
    hud.setActions([{ id: 'cnotes', label: `Edit notes.txt in ${CLONE}`, cmd: `echo … > /${CLONE}/notes.txt`, kind: 'primary', glow: true, onClick: () => void editNotes(CLONE) }])
    ctx.say(`\`${CLONE}\` exists, sharing every single block with @tuesday. Now change a file **in the clone**.`)
    await ctx.until(() => !busy && pool.dataset(CLONE) !== pool.snapshots.find((s) => s.name === 'tuesday')!.root)
    hud.setActions([])
    ctx.check('clone')
    await ctx.next(
      'The clone grew its own branch for the changed file (and its own dnode block and object set) while sharing everything else. That\'s how people spin up test copies of a database in seconds.',
    )

    // Incremental send
    ctx.unlock('send')
    const mon = pool.snapshots.find((s) => s.name === 'monday')!
    const tue = pool.snapshots.find((s) => s.name === 'tuesday')!
    await ctx.next(
      `Last trick: \`zfs send -i @monday @tuesday\` replicates only the changes between snapshots. Which blocks? Exactly those in @tuesday's tree **born after txg ${mon.txg}**. ZFS skips any subtree whose pointer has an older birth txg.`,
      'Highlight them',
    )
    const changed = [...pool.reachable([tue.root])].filter((b) => b.birth > mon.txg)
    tree.setLabels('birth')
    tree.highlight(changed, C.zil)
    term.echo(`zfs send -i ${DS}@monday ${DS}@tuesday | ssh backup zfs recv pool/home`)
    term.print(`# stream contains ${changed.filter((b) => b.kind === 'data').length} data blocks + ${changed.filter((b) => b.kind !== 'data').length} metadata blocks`, 'dim')
    ctx.check('send')
    await ctx.next(
      `The yellow blocks are the whole incremental stream: ${changed.filter((b) => b.kind === 'data').length} data blocks plus a little metadata, found without reading a single unchanged file. That's why ZFS replication is so efficient.`,
      'Take the checkpoint',
    )
    tree.highlight([], null)
    await ctx.finish()
  },
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
