import type { ChapterDef, Ctx } from './types'
import { v3 } from '../engine/kit'
import { h } from '../ui/dom'
import { CowPool, RING, textBytes, type Blk } from '../zfs/blocktree'
import { TreeView } from '../scenes/treeView'
import { describeBlock, describeUber, zdbUberText } from '../scenes/inspect'
import { catBlocks, CAT_EDITS, editBytes, drawPixels, NOTES, bytesToText } from '../content/files'
import { formatStatus } from '../zfs/status'

const DS = 'tank/home'
const TXG_TIMEOUT = 5

export const chapter3: ChapterDef = {
  id: 'cow',
  num: 3,
  title: 'Copy-on-Write',
  tagline: 'Edit a file and watch the change ripple up the tree to the uberblock. Then pull the plug mid-write.',
  tags: ['copy-on-write', 'txg', 'uberblock ring', 'no fsck'],
  summary: [
    '[[cow|Copy-on-write]]: a changed block goes to free space, and every ancestor up to the root is rewritten too.',
    'Changes collect in RAM and sync together in [[txg|transaction groups]], at least every 5 seconds.',
    'Writing the [[uberblock]] is the atomic commit. Crash before it, and the previous tree is intact.',
    'So ZFS is always consistent on disk and never needs fsck. At worst, the last few seconds are lost.',
  ],
  quiz: [
    {
      q: 'At what moment do the changes in a txg become permanent on disk?',
      options: [
        'When the new uberblock is written',
        'As soon as each new data block is written',
        'When the application\'s write() call returns',
        'When the old blocks are freed',
      ],
      answer: 0,
      explain: 'All the new blocks are written first, but nothing points at them until the uberblock moves. That single write flips the pool from the old tree to the new one.',
    },
    {
      q: 'Power fails halfway through a txg sync. What do you find after reboot?',
      options: [
        'The pool as of the previous txg, fully consistent',
        'A half-updated file that fsck must repair',
        'A pool that must be restored from backup',
        'All the new data, because those blocks were already on disk',
      ],
      answer: 0,
      explain: 'The previous uberblock still points at a complete tree, because copy-on-write never touched it. The half-written new blocks are simply free space.',
    },
    {
      q: 'Why does batching changes into one txg save work?',
      options: [
        'Shared ancestors (indirect, dnode, MOS) are rewritten once per txg, not once per change',
        'Compression works better on bigger batches',
        'It lets ZFS skip checksums for some blocks',
        'It lets the disk overwrite blocks in place',
      ],
      answer: 0,
      explain: 'Three edits to one file share the same L1, dnode block, object set and MOS. Synced together, each of those is written once.',
    },
    {
      q: 'With dirty data waiting, how often does ZFS sync a txg by default?',
      options: ['At least every 5 seconds', 'Every 30 seconds', 'Every 100 milliseconds', 'Only when an application calls fsync'],
      answer: 0,
      explain: '`zfs_txg_timeout` defaults to 5 seconds. A txg can also sync sooner if enough dirty data piles up. (fsync is handled by the ZIL; see chapter 7.)',
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
            { name: 'cat.png', blocks: original.map((b) => new Uint8Array(b)), birth: 2041 },
            { name: 'notes.txt', blocks: [textBytes('v1')], compressible: true, birth: 2040 },
          ],
        },
      ],
      { slots: 48, txg: 2040 },
    )
    for (const t of ['v2', 'v3', 'v4']) {
      pool.stageWrite(DS, 'notes.txt', 0, textBytes(t))
      pool.sync()
    }
    pool.stageWrite(DS, 'notes.txt', 0, NOTES)
    pool.sync()

    const tree = new TreeView(stage, scope, pool, { dataset: DS, cols: 12, rows: 4, showRing: true })

    // --------------------------------------------------------------- state
    const editOn = [false, false, false, false]
    let auto = false
    let timer = 0
    let quiescing: number | null = null
    let syncing = false
    let power: 'on' | 'off' = 'on'
    let syncRequests = 0
    let syncsDone = 0
    let autoSyncs = 0
    let crashedMidSync = false
    let lastStats = { blocks: 0, changes: 0 }

    // ---------------------------------------------------------- info panel
    const box = (label: string) => {
      const v = h('b', { class: 'mono', style: { fontSize: '15px' } }, '—')
      const el = h(
        'div',
        { style: { flex: '1', padding: '6px 4px', borderRadius: '7px', border: '1px solid var(--line)', textAlign: 'center', minWidth: '0' } },
        h('div', { style: { fontSize: '10.5px', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--fg-dim)' } }, label),
        v,
      )
      return { el, v }
    }
    const bOpen = box('open')
    const bQuiesce = box('quiescing')
    const bSync = box('syncing')
    const timerFill = h('div', { class: 'fill', style: { width: '0%' } })
    const timerLab = h('b', null, 'off')
    const dirtyEl = h('div', { class: 'note', style: { marginTop: '4px' } })
    const statsEl = h('div', { class: 'note', style: { marginTop: '2px' } })
    const ramCanvas = h('canvas', { width: 16, height: 16, 'aria-label': 'cat.png as applications see it' }) as HTMLCanvasElement
    const diskCanvas = h('canvas', { width: 16, height: 16, 'aria-label': 'cat.png as stored on disk' }) as HTMLCanvasElement
    const diskLab = h('div', { class: 'note', style: { margin: '4px 0 0', textAlign: 'center' } })
    const pic = (c: HTMLCanvasElement, label: HTMLElement | string) =>
      h('div', { style: { display: 'grid', justifyItems: 'center' } }, c, typeof label === 'string' ? h('div', { class: 'note', style: { margin: '4px 0 0', textAlign: 'center' } }, label) : label)
    const panel = h(
      'div',
      null,
      h('h3', null, 'Transaction groups'),
      h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, bOpen.el, h('span', { style: { color: 'var(--fg-faint)' } }, '→'), bQuiesce.el, h('span', { style: { color: 'var(--fg-faint)' } }, '→'), bSync.el),
      h('div', { class: 'meter' }, h('div', { class: 'lab' }, h('span', null, 'txg timer'), timerLab), h('div', { class: 'track' }, timerFill)),
      dirtyEl,
      statsEl,
      h('h3', { style: { marginTop: '12px' } }, 'cat.png'),
      h('div', { class: 'pixel-file', style: { justifyContent: 'space-around', marginTop: '4px' } }, pic(ramCanvas, 'in RAM (what apps see)'), pic(diskCanvas, diskLab)),
    )
    ;[ramCanvas, diskCanvas].forEach((c) => {
      c.style.width = '84px'
      c.style.height = '84px'
    })
    hud.info(panel)

    function renderPanel() {
      bOpen.v.textContent = power === 'on' ? String(pool.openTxg) : '—'
      bQuiesce.v.textContent = quiescing ? String(quiescing) : '—'
      bSync.v.textContent = pool.syncing ? String(pool.syncing.txg) : '—'
      bQuiesce.el.style.borderColor = quiescing ? 'var(--amber)' : 'var(--line)'
      bSync.el.style.borderColor = pool.syncing ? 'var(--amber)' : 'var(--line)'
      timerLab.textContent = auto ? (syncing ? 'syncing…' : `${Math.max(0, TXG_TIMEOUT - timer).toFixed(1)} s`) : 'manual'
      timerFill.style.width = auto ? `${(timer / TXG_TIMEOUT) * 100}%` : '0%'
      const d = pool.dirtyCount()
      dirtyEl.textContent = power === 'off' ? 'Power is off. RAM is empty.' : d ? `Dirty in RAM: ${d} changed block${d > 1 ? 's' : ''} waiting for txg ${pool.openTxg}` : 'No dirty data in RAM.'
      statsEl.textContent = lastStats.blocks ? `Last sync: ${lastStats.changes} change${lastStats.changes > 1 ? 's' : ''} → ${lastStats.blocks} block writes` : ''
      drawPixels(ramCanvas, [0, 1, 2, 3].map((i) => (power === 'on' ? pool.contents(DS, 'cat.png', i) : null)))
      drawPixels(diskCanvas, pool.fileBlocks(DS, 'cat.png').map((b) => pool.media[b.slot]))
      diskLab.textContent = `on disk (txg ${pool.txg})`
      hud.stats([
        { k: 'txg', v: String(pool.txg) },
        { k: 'open', v: power === 'on' ? String(pool.openTxg) : '—', narrowHide: true },
      ])
    }

    // ------------------------------------------------------------- actions
    function edit(i: number) {
      if (power === 'off') return
      const e = CAT_EDITS[i]
      editOn[i] = !editOn[i]
      pool.stageWrite(DS, 'cat.png', e.block, editOn[i] ? editBytes(e.rows) : original[e.block])
      term.echo(`# app writes cat.png block ${e.block} (${editOn[i] ? e.label.toLowerCase() : 'undo'})`)
      sound.tick()
      hud.updateAction(e.id, { label: `${e.label}${editOn[i] ? ' ✓' : ''}` })
      renderPanel()
    }

    hud.setActions([
      ...CAT_EDITS.map((e, i) => ({ id: e.id, label: e.label, cmd: `write block ${e.block}`, onClick: () => edit(i) })),
      { id: 'sync', label: 'Sync now', cmd: 'zpool sync tank', kind: 'primary' as const, onClick: () => requestSync(true) },
      { id: 'plug', label: 'Pull the plug', cmd: 'power failure', kind: 'danger' as const, hidden: true, onClick: () => void pullPlug() },
    ])

    function requestSync(echo: boolean) {
      if (power === 'off') return
      if (echo) term.echo('zpool sync tank')
      if (pool.dirtyCount() === 0 && !syncing) {
        term.print('# nothing dirty: txg has no changes to write', 'dim')
        return
      }
      syncRequests++
    }

    tree.onPick = (b: Blk) => {
      sound.click()
      hud.inspect({ eyebrow: 'Block pointer', title: `${b.kind === 'data' ? `${b.meta.file} · L0` : b.kind} · birth ${b.birth}`, body: describeBlock(pool, b) })
    }
    tree.onPickUber = () => hud.inspect({ eyebrow: 'Vdev label', title: `Uberblock · txg ${pool.txg}`, body: describeUber(pool) })

    // ---------------------------------------------------------------- sync
    let narrate: ((step: 'data' | 'parent' | 'rest' | 'uber' | 'free') => Promise<void>) | null = null
    let tearNext = false

    // A function, so TypeScript doesn't narrow `power` across awaits.
    const isOff = () => power === 'off'

    async function runSync(): Promise<'ok' | 'crash'> {
      syncing = true
      try {
        quiescing = pool.openTxg
        renderPanel()
        await ctx.sleep(0.45)
        quiescing = null
        const plan = pool.beginSync()
        if (!plan) return 'ok'
        const changes = [...plan.dirty.values()].reduce((n, f) => n + [...f.values()].reduce((m, x) => m + x.size, 0), 0)
        tree.hidden = new Set(plan.written)
        tree.setPlan(plan)
        renderPanel()
        const slow = !!narrate
        for (let i = 0; i < plan.written.length; i++) {
          if (isOff()) return 'crash'
          const b = plan.written[i]
          await tree.rise(b, slow ? 0.8 : 0.32)
          sound.write()
          if (narrate) {
            if (b.kind === 'data' && plan.written[i + 1]?.kind !== 'data') await narrate('data')
            else if (b.kind === 'indirect') await narrate('parent')
            else if (b.kind === 'mos') await narrate('rest')
          }
        }
        if (isOff()) return 'crash'
        if (tearNext) {
          tearNext = false
          pool.tearUberblock(plan)
          return 'crash'
        }
        if (narrate) await narrate('uber')
        await ctx.sleep(slow ? 0.3 : 0.15)
        if (isOff()) return 'crash'
        const res = pool.commitSync(plan)
        tree.setPlan(null)
        sound.commit()
        tree.refresh()
        await tree.commit()
        if (narrate) await narrate('free')
        lastStats = { blocks: res.written.length, changes }
        syncsDone++
        renderPanel()
        return 'ok'
      } finally {
        syncing = false
        quiescing = null
      }
    }

    scope.onUpdate((dt) => {
      if (power === 'off') return
      if (!syncing && syncRequests > 0) {
        syncRequests = 0
        void runSync()
          .then((r) => {
            if (r === 'crash') crashedMidSync = true
          })
          .catch(() => {})
      }
      if (auto && !syncing) {
        if (pool.dirtyCount() > 0) timer += dt
        else timer = Math.max(0, timer - dt)
        if (timer >= TXG_TIMEOUT) {
          timer = 0
          autoSyncs++
          syncRequests++
        }
      }
      renderPanel()
    })

    // ---------------------------------------------------------- power cut
    const overlay = h('div', {
      style: {
        position: 'fixed',
        inset: '0',
        background: 'rgba(0,0,0,0.92)',
        zIndex: '45',
        display: 'grid',
        placeItems: 'center',
        transition: 'opacity 0.5s',
        opacity: '0',
        pointerEvents: 'none',
      },
    })
    document.getElementById('app')!.append(overlay)
    scope.add(() => overlay.remove())

    async function pullPlug() {
      if (power === 'off') return
      const wasSyncing = syncing
      power = 'off'
      sound.power()
      hud.updateAction('plug', { disabled: true })
      await ctx.until(() => !syncing)
      crashedMidSync = wasSyncing
      await blackout(wasSyncing ? 'Power lost in the middle of a txg sync.' : 'Power lost. The disks were idle.')
    }

    async function blackout(msg: string) {
      overlay.replaceChildren(
        h(
          'div',
          { style: { textAlign: 'center', display: 'grid', gap: '14px', justifyItems: 'center', padding: '0 20px' } },
          h('div', { style: { fontFamily: 'var(--font-display)', fontSize: '28px', color: 'var(--fg)' } }, msg),
          h('div', { style: { color: 'var(--fg-dim)', maxWidth: '44ch' } }, 'Everything in RAM, including the open transaction group, is gone. What survives is whatever is on the disk.'),
        ),
      )
      overlay.style.pointerEvents = 'auto'
      overlay.style.opacity = '1'
      await ctx.sleep(0.6)
      const btn = h('button', { class: 'btn primary' }, 'Power on')
      overlay.firstElementChild!.append(btn)
      await scope.guard(new Promise<void>((r) => btn.addEventListener('click', () => r(), { once: true })))
      sound.boot()
      overlay.style.opacity = '0'
      overlay.style.pointerEvents = 'none'
      overlay.replaceChildren()
      await reboot()
    }

    async function reboot() {
      term.echo('zpool import tank')
      // Scan the label's uberblock ring, as import does.
      const ringTiles = [...Array(RING).keys()]
      for (const i of ringTiles) {
        const u = pool.ring[i]
        if (u) tree.flashUber()
        await ctx.sleep(0.12)
      }
      const { uber, orphans } = pool.importPool()
      const torn = pool.ring.find((u) => u && !u.valid)
      term.print(
        `# scanned ${RING} uberblock slots${torn ? `; txg ${torn.txg} failed its checksum (torn write)` : ''}\n# using uberblock txg ${uber.txg}; ${orphans.length} unreferenced block${orphans.length === 1 ? '' : 's'} returned to free space`,
        'dim',
      )
      tree.setPlan(null)
      tree.hidden.clear()
      tree.refresh()
      power = 'on'
      timer = 0
      editOn.fill(false)
      // The app's view resets to what's on disk.
      const onDisk = pool.fileBlocks(DS, 'cat.png').map((b) => b.data)
      onDisk.forEach((d, i) => (editOn[i] = !sameBytes(d, original[i])))
      CAT_EDITS.forEach((e, i) => hud.updateAction(e.id, { label: `${e.label}${editOn[i] ? ' ✓' : ''}` }))
      hud.updateAction('plug', { disabled: false })
      renderPanel()
      await tree.commit()
    }

    // ------------------------------------------------------------ terminal
    term.setHandler(
      (argv, line) => {
        const [cmd, a1] = argv
        if (cmd === 'sync' || (cmd === 'zpool' && a1 === 'sync')) {
          requestSync(false)
          return true
        }
        if (cmd === 'echo' && line.includes('>')) {
          const m = line.match(/^echo\s+(?:"([^"]*)"|'([^']*)'|(.*?))\s*>>?\s*(\S+)$/)
          const target = m?.[4]?.split('/').pop()
          if (!m || target !== 'notes.txt') {
            term.print('Only /tank/home/notes.txt is writable in this lab.', 'warn')
            return true
          }
          if (power === 'off') return true
          pool.stageWrite(DS, 'notes.txt', 0, textBytes(m[1] ?? m[2] ?? m[3] ?? ''))
          renderPanel()
          return true
        }
        if (cmd === 'cat') {
          const f = (a1 ?? '').split('/').pop()
          if (f === 'notes.txt') term.print(bytesToText(pool.contents(DS, 'notes.txt', 0)))
          else if (f === 'cat.png') term.print('(binary; see the picture in the panel)', 'dim')
          else term.print(`cat: ${a1 ?? ''}: No such file or directory`, 'err')
          return true
        }
        if (cmd === 'zdb' && a1 === '-u') {
          term.print(zdbUberText(pool))
          return true
        }
        if (cmd === 'zpool' && a1 === 'status') {
          term.print(formatStatus({ pool: 'tank', state: 'ONLINE', vdevs: [{ name: 'sda', state: 'ONLINE' }] }))
          return true
        }
        return false
      },
      [
        'Commands in this chapter:',
        '  zpool sync tank                       force the open txg to sync now',
        '  echo "hello" > /tank/home/notes.txt   change a file',
        '  cat /tank/home/notes.txt',
        '  zdb -u tank                           show the active uberblock',
        '  zpool status',
      ].join('\n'),
    )
    term.setSuggestions(['zpool sync tank', 'echo "hi" > /tank/home/notes.txt', 'zdb -u tank'])

    // -------------------------------------------------------------- script
    renderPanel()
    await ctx.fly(v3(0, 11, 27), v3(0, 5.2, 2.4), 2)
    ctx.objectives([
      { id: 'edit', text: 'Edit cat.png' },
      { id: 'sync', text: 'Sync the txg and watch [[cow|copy-on-write]]' },
      { id: 'batch', text: 'Batch 3 edits into one txg' },
      { id: 'auto', text: 'Let the 5-second txg timer run twice' },
      { id: 'crash', text: 'Pull the plug in the middle of a sync' },
      { id: 'torn', text: 'Survive a torn uberblock write' },
    ])
    ctx.unlock('cow', 'txg')

    await ctx.next(
      'Same pool as before, with one addition at the front: the **uberblock ring** from the disk label. Every txg writes the next uberblock into the next slot, wrapping around.',
    )
    ctx.say('Let\'s change a file. Pick an edit for `cat.png` in the buttons below. Each one rewrites one of its four data blocks.')
    await ctx.until(() => pool.dirtyCount() > 0)
    ctx.check('edit')
    await ctx.next(
      `Look at the two pictures. Applications already see the change, because it's in RAM as part of **open txg ${pool.openTxg}**. The disk still has the old picture. Nothing on disk has been touched yet.`,
    )

    // Slow-motion sync with narration.
    narrate = async (step) => {
      const lines = {
        data: 'First, the new data block. ZFS **never** overwrites the old one: the new version goes to free space (amber means written but not live yet).',
        parent: 'That block now has a new address and checksum, so its parent L1 must change too. L1 can\'t be overwritten either, so a new copy goes elsewhere.',
        rest: 'Same story all the way up: a new dnode block, a new object set, a new MOS. The new branch is complete, but nothing points at it yet.',
        uber: 'The commit. ZFS writes a new uberblock into the next slot of the ring. That one small write switches the pool to the new tree.',
        free: 'Done. The new tree is live, and the old blocks it replaced are unreferenced, so they go back to free space.',
      }
      await ctx.next(lines[step])
    }
    ctx.say('Now press **Sync now** (`zpool sync tank`). I\'ll pause at each step.')
    hud.updateAction('sync', { glow: true })
    await ctx.until(() => syncsDone >= 1)
    hud.updateAction('sync', { glow: false })
    narrate = null
    ctx.check('sync')
    await ctx.next(
      'That\'s [[cow|copy-on-write]]: changing one block wrote **five** (data, L1, dnode, object set, MOS) plus the uberblock. That sounds wasteful, until you batch.',
    )

    // Batching
    ctx.say('Make **three different edits**, then sync. Watch how many blocks get written.')
    const before = syncsDone
    await ctx.until(() => syncsDone > before && lastStats.changes >= 3)
    ctx.check('batch')
    await ctx.next(
      `${lastStats.changes} changes, **${lastStats.blocks} block writes**. Done one at a time, that would have been ${lastStats.changes * 5}. All the changed blocks share the same ancestors, so a txg rewrites each ancestor once. ZFS also lays those writes out together, so they go to disk fast.`,
    )

    // Auto timer
    auto = true
    timer = 0
    ctx.say(
      'Real ZFS doesn\'t wait for you. With dirty data in RAM it syncs at least every **5 seconds** (`zfs_txg_timeout`). The timer is now on. Keep editing and watch txgs roll by.',
    )
    const a0 = autoSyncs
    await ctx.until(() => autoSyncs >= a0 + 2 && !syncing)
    ctx.check('auto')

    // Power cut
    hud.updateAction('plug', { hidden: false, glow: true })
    ctx.unlock('uberblock')
    crashedMidSync = false
    ctx.say(
      'Now the scary part. Keep editing, and while a sync is writing blocks (they glow amber), hit **Pull the plug**.',
    )
    for (;;) {
      await ctx.until(() => power === 'off')
      await ctx.until(() => power === 'on')
      if (crashedMidSync) break
      void ctx.say('The disks were idle that time, so there was nothing to interrupt. Try again: make an edit and pull the plug **while blocks are glowing amber**.')
    }
    hud.updateAction('plug', { glow: false })
    ctx.check('crash')
    await ctx.next(
      `Power's back. Import read the uberblock ring and picked the newest valid entry, **txg ${pool.txg}**. That tree is complete, because copy-on-write never modified it. The half-written blocks were never referenced, so they're just free space again.`,
    )
    await ctx.next(
      'You lost the last few seconds of edits, but nothing is corrupt and nothing needs repair. There is no fsck for ZFS, because there\'s nothing for it to fix.',
    )

    // Torn uberblock
    auto = false
    timer = 0
    hud.updateAction('plug', { hidden: true })
    await ctx.next(
      'One last nightmare: what if the power fails **while the uberblock itself** is being written? Let me stage an edit and arrange exactly that.',
      'Show me',
    )
    if (pool.dirtyCount() === 0) {
      const i = editOn.findIndex((on) => !on)
      edit(i >= 0 ? i : 0)
    }
    crashedMidSync = false
    tearNext = true
    syncRequests++
    await ctx.until(() => crashedMidSync && !syncing)
    power = 'off'
    sound.power()
    await blackout('Power lost while writing the uberblock.')
    ctx.check('torn')
    await ctx.next(
      'See the red slot in the ring? Every uberblock carries its own checksum. The torn one failed it, so import skipped it and used the previous txg. The worst case is losing the last txg; consistency is never at risk. If recent txgs ever are damaged, `zpool import -F` can deliberately rewind to an older uberblock.',
      'Take the checkpoint',
    )
    await ctx.finish()
  },
}

function sameBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

