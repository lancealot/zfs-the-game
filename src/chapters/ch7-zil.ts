import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import type { ChapterDef, Ctx } from './types'
import { BlockView, DriveView, Platter, C, makeLabel, burst, v3 } from '../engine/kit'
import { Ease } from '../engine/anim'
import { h } from '../ui/dom'
import { formatStatus } from '../zfs/status'

const TXG_SECONDS = 5

interface Write {
  id: number
  kind: 'sync' | 'async'
  txg: number
  view: BlockView
  acked: boolean
  committed: boolean
  log: BlockView | null
  ramSlot: number
}

export const chapter7: ChapterDef = {
  id: 'zil',
  num: 7,
  title: 'The Intent Log',
  tagline: 'A database calls fsync. Make it fast with a SLOG, crash the box, and watch the ZIL replay.',
  tags: ['ZIL', 'SLOG', 'fsync', 'sync=disabled'],
  summary: [
    'Async writes are acknowledged from RAM and reach the disks with the next [[txg]].',
    'Sync writes are logged to the [[zil|ZIL]] before they are acknowledged, and still written normally with the txg.',
    'A [[slog|SLOG]] puts the ZIL on fast, power-safe media. It cuts latency; it is not a write cache.',
    'After a crash, ZIL replay restores every acknowledged sync write. `sync=disabled` throws that guarantee away.',
  ],
  quiz: [
    {
      q: 'When does ZFS read the ZIL?',
      options: ['Only after a crash or power loss, to replay it', 'On every read of recently written data', 'At the end of every txg', 'During scrubs'],
      answer: 0,
      explain: 'In normal operation the ZIL is write-only. Its records are discarded once their txg commits. It is read only to replay acknowledged writes after an unclean shutdown.',
    },
    {
      q: 'Is a SLOG a write cache?',
      options: [
        'No. Data still goes from RAM to the pool; the SLOG only holds log records for crash recovery',
        'Yes, every write lands there first and is copied to the pool later',
        'Yes, but only for async writes',
        'No, it\'s a read cache',
      ],
      answer: 0,
      explain: 'This is the most common ZFS myth. A SLOG speeds up sync writes by giving the ZIL a fast home. It does nothing for async writes and doesn\'t make the pool absorb more data.',
    },
    {
      q: 'Which writes go through the ZIL?',
      options: ['Synchronous writes: fsync, O_SYNC, NFS commits, sync=always', 'All writes', 'Only metadata changes', 'Only writes larger than recordsize'],
      answer: 0,
      explain: 'Plain buffered writes don\'t wait for the ZIL; they\'re batched in RAM for the next txg. Log records are committed only when durability is requested, and an fsync() also logs that file\'s earlier buffered writes.',
    },
    {
      q: 'What can a crash cost you with `sync=disabled`?',
      options: ['Writes that applications were told were safe', 'Pool consistency', 'Nothing at all', 'Every snapshot'],
      answer: 0,
      explain: 'The pool stays consistent (that\'s copy-on-write), but the last few seconds of "durable" writes vanish. A database may then disagree with its own clients.',
    },
  ],

  async run(ctx: Ctx) {
    const { stage, hud, term, sound, scope, root } = ctx
    stage.camera.position.set(0, 14, 30)
    stage.controls.target.set(0, 2, 0)

    // ---------------------------------------------------------------- scene
    const appPos = { db: v3(-9, 0, -1.6), up: v3(-9, 0, 2.2) }
    const mkApp = (pos: THREE.Vector3, color: string, text: string) => {
      const ped = new THREE.Mesh(
        new THREE.CylinderGeometry(0.9, 1.05, 0.9, 32),
        new THREE.MeshStandardMaterial({ color: C.steel, metalness: 0.6, roughness: 0.4, emissive: color, emissiveIntensity: 0.08 }),
      )
      ped.position.copy(pos).setY(0.45)
      ped.castShadow = true
      root.add(ped)
      const lbl = makeLabel(text, 'big')
      lbl.position.copy(pos).setY(1.25)
      lbl.center.set(0.5, 1)
      root.add(lbl)
      return { ped, lbl }
    }
    const dbApp = mkApp(appPos.db, C.zil, '<b>postgres</b> · fsync()')
    const upApp = mkApp(appPos.up, C.data, '<b>uploader</b> · async')

    // RAM tray
    const ramCenter = v3(-2.6, 0, 0.3)
    const tray = new THREE.Mesh(
      new RoundedBoxGeometry(4.4, 0.5, 4.4, 2, 0.1),
      new THREE.MeshStandardMaterial({ color: '#1b2c52', transparent: true, opacity: 0.55, metalness: 0.2, roughness: 0.2, emissive: '#1b2c52', emissiveIntensity: 0.3 }),
    )
    tray.position.copy(ramCenter).setY(0.25)
    root.add(tray)
    const ramLbl = makeLabel('', 'big blue')
    ramLbl.position.copy(ramCenter).setY(0.5).add(v3(0, 0, 2.6))
    ramLbl.center.set(0.5, 0)
    root.add(ramLbl)
    const RAM_SLOTS = 36
    const ramSlotPos = (i: number) => v3(ramCenter.x + ((i % 6) - 2.5) * 0.66, 0.75 + Math.floor(i / 36) * 0.4, ramCenter.z + (Math.floor(i / 6) % 6 - 2.5) * 0.66)

    // Pool disks (a mirror of two HDDs)
    const disks = [new Platter(6, 3, 0.62, 'sda'), new Platter(6, 3, 0.62, 'sdb')]
    disks[0].position.set(5.6, 0, -1.6)
    disks[1].position.set(5.6, 0, 1.6)
    disks.forEach((d) => root.add(d))
    const poolLbl = makeLabel('pool · mirror of two HDDs', 'platter')
    poolLbl.position.set(5.6, 0.2, 3.4)
    poolLbl.center.set(0.5, 0)
    root.add(poolLbl)
    let diskCursor = 0

    // ZIL chain location: on the pool, or on the SLOG once added.
    const zilInPool = v3(5.6, 1.4, -0.0)
    const slogPos = v3(1.8, 0, 4.6)
    let slog: DriveView | null = null
    const zilLbl = makeLabel('ZIL · in the pool', 'amber')
    zilLbl.position.copy(zilInPool).add(v3(0, 0.6, 0))
    root.add(zilLbl)

    // ---------------------------------------------------------------- state
    let nextId = 1
    let openTxg = 5021
    let txgTimer = 0
    let running = false
    let power: 'on' | 'off' = 'on'
    let syncProp: 'standard' | 'disabled' = 'standard'
    let dbRate = 0
    let upRate = 0
    let dbAcc = 0
    let upAcc = 0
    const writes: Write[] = []
    const latencies: number[] = []
    let syncsDone = 0
    let lastCrash = { ackedSync: 0, recovered: 0, asyncLost: 0, ackedLost: 0 }
    const isOff = () => power === 'off'

    const zilRecords = () => writes.filter((w) => w.log && !w.committed)
    const inRam = () => writes.filter((w) => !w.committed)

    function zilAnchor() {
      return slog ? slog.position.clone().add(v3(0, 0.9, 0)) : zilInPool.clone()
    }
    function layoutZil() {
      const recs = zilRecords()
      const a = zilAnchor()
      recs.forEach((w, i) => {
        const target = a.clone().add(v3((i % 8 - 3.5) * 0.36, Math.floor(i / 8) * 0.36, 0))
        w.log!.userData.target = target
      })
    }

    function freeRamSlot() {
      const used = new Set(inRam().map((w) => w.ramSlot))
      for (let i = 0; i < RAM_SLOTS * 3; i++) if (!used.has(i)) return i
      return 0
    }

    function ack(w: Write, latencyMs: number | null) {
      w.acked = true
      const app = w.kind === 'sync' ? dbApp : upApp
      const m = app.ped.material as THREE.MeshStandardMaterial
      m.emissive.set(C.ok)
      m.emissiveIntensity = 0.5
      setTimeout(() => {
        m.emissive.set(w.kind === 'sync' ? C.zil : C.data)
        m.emissiveIntensity = 0.08
      }, 160)
      if (latencyMs !== null) {
        latencies.push(latencyMs)
        if (latencies.length > 40) latencies.shift()
      }
    }

    async function issue(kind: 'sync' | 'async') {
      if (isOff()) return
      const w: Write = {
        id: nextId++,
        kind,
        txg: openTxg,
        view: new BlockView(kind === 'sync' ? '#ffd27a' : C.data, 0.3, 0.6),
        acked: false,
        committed: false,
        log: null,
        ramSlot: freeRamSlot(),
      }
      writes.push(w)
      const from = (kind === 'sync' ? appPos.db : appPos.up).clone().setY(1.1)
      w.view.position.copy(from)
      root.add(w.view)
      const toRam = fly(w.view, from, ramSlotPos(w.ramSlot), 0.45)
      if (kind === 'sync' && syncProp === 'standard') {
        // The log record must be on stable storage before fsync() returns.
        w.log = new BlockView(C.zil, 0.26, 0.9)
        w.log.position.copy(from)
        root.add(w.log)
        layoutZil()
        const visual = slog ? 0.22 : 0.95
        await fly(w.log, from, w.log.userData.target as THREE.Vector3, visual)
        if (isOff()) return
        ack(w, slog ? 0.04 + Math.random() * 0.05 : 5.5 + Math.random() * 4)
        sound.tick()
      } else {
        // Async (or sync=disabled): acknowledged as soon as it's in RAM.
        await ctx.sleep(0.05)
        ack(w, kind === 'sync' ? 0.01 : null)
      }
      await toRam
    }

    function fly(obj: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3, seconds: number, arc = 1.2) {
      return ctx
        .tween(
          seconds,
          (k) => {
            obj.position.lerpVectors(from, to, k)
            obj.position.y += Math.sin(k * Math.PI) * arc
          },
          Ease.inOut,
        )
        .catch(() => {})
    }

    function diskSlot() {
      const n = disks[0].tiles.length
      return diskCursor++ % n
    }

    let syncing = false
    async function txgSync() {
      if (syncing || isOff()) return
      syncing = true
      const txg = openTxg
      openTxg++
      const batch = writes.filter((w) => !w.committed && w.txg === txg)
      await Promise.all(
        batch.map(async (w, i) => {
          await ctx.sleep(i * 0.03)
          if (isOff()) return
          const slot = diskSlot()
          const to = disks[i % 2].worldSlot(slot).setY(0.5)
          await fly(w.view, w.view.position.clone(), to, 0.5, 1.6)
          if (isOff()) return
          for (const d of disks) d.setTile(slot, w.kind === 'sync' ? '#d9b65c' : C.data, 0.5)
        }),
      )
      if (isOff()) {
        syncing = false
        return
      }
      sound.commit()
      for (const w of batch) {
        w.committed = true
        root.remove(w.view)
        w.view.mat.dispose()
        if (w.log) {
          // Committed: the log record is no longer needed.
          const lg = w.log
          w.log = null
          void ctx.tween(0.5, (k) => lg.setOpacity(1 - k)).then(() => {
            root.remove(lg)
            lg.mat.dispose()
          }).catch(() => {})
        }
      }
      writes.splice(0, writes.length, ...writes.filter((w) => !w.committed))
      layoutZil()
      syncsDone++
      syncing = false
    }

    scope.onUpdate((dt) => {
      // Glide ZIL records toward their slots in the chain.
      for (const w of writes) {
        if (w.log && w.log.userData.target && !w.log.userData.flying) w.log.position.lerp(w.log.userData.target as THREE.Vector3, 1 - Math.exp(-dt * 8))
      }
      if (!running || isOff()) return
      dbAcc += dt * dbRate
      upAcc += dt * upRate
      while (dbAcc >= 1) {
        dbAcc -= 1
        void issue('sync')
      }
      while (upAcc >= 1) {
        upAcc -= 1
        void issue('async')
      }
      txgTimer += dt
      if (txgTimer >= TXG_SECONDS) {
        txgTimer = 0
        void txgSync()
      }
      renderPanel()
    })

    // ---------------------------------------------------------------- panel
    const latBig = h('div', { class: 'mono', style: { fontSize: '26px', fontWeight: '600', color: 'var(--fg)' } }, '—')
    const spark = h('canvas', { class: 'spark', width: 300, height: 54, 'aria-label': 'Recent sync write latency' }) as HTMLCanvasElement
    const timerFill = h('div', { class: 'fill' })
    const counts = h('div', { class: 'note', style: { marginTop: '4px' } })
    hud.info(
      h(
        'div',
        null,
        h('h3', null, 'fsync() latency'),
        latBig,
        spark,
        h('div', { class: 'meter' }, h('div', { class: 'lab' }, h('span', null, 'next txg sync'), h('b', null, '')), h('div', { class: 'track' }, timerFill)),
        counts,
        h('div', { class: 'legend', style: { marginTop: '8px' } }, h('span', null, h('i', { style: { background: '#ffd27a' } }), 'sync write'), h('span', null, h('i', { style: { background: C.data } }), 'async write'), h('span', null, h('i', { style: { background: C.zil } }), 'ZIL record')),
      ),
    )

    function avgLatency() {
      const recent = latencies.slice(-8)
      return recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0
    }

    function renderPanel() {
      const avg = avgLatency()
      latBig.textContent = latencies.length ? (avg >= 1 ? `${avg.toFixed(1)} ms` : `${(avg * 1000).toFixed(0)} µs`) : '—'
      latBig.style.color = !latencies.length ? 'var(--fg)' : avg < 1 ? 'var(--mint)' : 'var(--amber)'
      timerFill.style.width = `${(txgTimer / TXG_SECONDS) * 100}%`
      const ram = inRam().length
      counts.textContent = `RAM: ${ram} dirty write${ram === 1 ? '' : 's'} · ZIL: ${zilRecords().length} record${zilRecords().length === 1 ? '' : 's'} · sync=${syncProp}`
      ramLbl.element.innerHTML = `RAM · open txg <b>${openTxg}</b>`
      const ctx2 = spark.getContext('2d')
      if (ctx2) {
        const W = spark.width
        const H = spark.height
        ctx2.clearRect(0, 0, W, H)
        ctx2.strokeStyle = 'rgba(147,163,196,0.25)'
        ctx2.setLineDash([3, 3])
        const y1 = H - (Math.log10(1 * 100 + 1) / Math.log10(1201)) * (H - 6) - 3
        ctx2.beginPath()
        ctx2.moveTo(0, y1)
        ctx2.lineTo(W, y1)
        ctx2.stroke()
        ctx2.setLineDash([])
        ctx2.fillStyle = 'rgba(147,163,196,0.7)'
        ctx2.font = '10px JetBrains Mono, monospace'
        ctx2.fillText('1 ms', 4, y1 - 3)
        if (latencies.length > 1) {
          ctx2.strokeStyle = avg < 1 ? '#3ee0a1' : '#ffb21e'
          ctx2.lineWidth = 2
          ctx2.beginPath()
          latencies.forEach((l, i) => {
            const x = (i / 39) * W
            const y = H - (Math.log10(l * 100 + 1) / Math.log10(1201)) * (H - 6) - 3
            if (i === 0) ctx2.moveTo(x, y)
            else ctx2.lineTo(x, y)
          })
          ctx2.stroke()
        }
      }
      hud.stats([
        { k: 'open txg', v: String(openTxg) },
        { k: 'log', v: slog ? 'nvme0n1' : 'in pool', kind: slog ? 'ok' : undefined, narrowHide: true },
      ])
    }

    // ------------------------------------------------------------ power cut
    const overlay = h('div', { style: { position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.92)', zIndex: '45', display: 'grid', placeItems: 'center', transition: 'opacity 0.5s', opacity: '0', pointerEvents: 'none' } })
    document.getElementById('app')!.append(overlay)
    scope.add(() => overlay.remove())

    async function crash() {
      if (isOff()) return
      power = 'off'
      running = false
      sound.power()
      // Everything in RAM is gone. ZIL records on stable storage survive.
      const lostRam = inRam()
      const ackedSync = lostRam.filter((w) => w.kind === 'sync' && w.acked).length
      // Acknowledged but never logged (sync=disabled): nothing can bring these back.
      const ackedLost = lostRam.filter((w) => w.kind === 'sync' && w.acked && !w.log).length
      const asyncLost = lostRam.filter((w) => w.kind === 'async').length
      for (const w of lostRam) {
        burst(scope, root, w.view.position.clone(), C.bad, 6, 0.5)
        w.view.visible = false
      }
      overlay.replaceChildren(
        h(
          'div',
          { style: { textAlign: 'center', display: 'grid', gap: '14px', justifyItems: 'center', padding: '0 20px' } },
          h('div', { style: { fontFamily: 'var(--font-display)', fontSize: '28px' } }, 'Power lost.'),
          h('div', { style: { color: 'var(--fg-dim)', maxWidth: '46ch' } }, `RAM held ${lostRam.length} writes that hadn't reached their final place yet. ${ackedSync} of them were sync writes the database was told were safe.`),
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
      term.echo('zpool import tank')
      term.print('# mounting tank/db: replaying intent log', 'dim')
      // Replay: every surviving log record is applied, then committed in a fresh txg.
      const recs = lostRam.filter((w) => w.log)
      let recovered = 0
      for (const w of recs) {
        const lg = w.log!
        lg.userData.flying = true
        const slot = diskSlot()
        await fly(lg, lg.position.clone(), disks[recovered % 2].worldSlot(slot).setY(0.5), 0.35, 1.2)
        for (const d of disks) d.setTile(slot, '#d9b65c', 0.9)
        root.remove(lg)
        lg.mat.dispose()
        w.log = null
        recovered++
        sound.write()
      }
      for (const w of lostRam) {
        root.remove(w.view)
        w.view.mat.dispose()
      }
      writes.splice(0, writes.length)
      lastCrash = { ackedSync, recovered, asyncLost, ackedLost }
      term.print(`# replayed ${recovered} ZIL record${recovered === 1 ? '' : 's'}${ackedLost > 0 ? `; ${ackedLost} acknowledged write${ackedLost === 1 ? ' was' : 's were'} never logged and are gone` : ''}`, ackedLost > 0 ? 'err' : 'ok')
      openTxg += 2
      txgTimer = 0
      power = 'on'
      running = true
      renderPanel()
    }

    // ---------------------------------------------------------------- slog
    let slogAdded = false
    async function addSlog(echo = true) {
      if (slog) return
      if (echo) term.echo('zpool add tank log nvme0n1')
      slog = new DriveView('nvme0n1', 'SLOG · PLP', 'nvme')
      slog.position.copy(slogPos)
      slog.scale.setScalar(0.01)
      root.add(slog)
      await ctx.tween(0.6, (k) => slog!.scale.setScalar(Math.max(0.01, k)), Ease.outBack)
      zilLbl.position.copy(slogPos).add(v3(0, 1.6, 0))
      zilLbl.element.textContent = 'ZIL · on the SLOG'
      layoutZil()
      slogAdded = true
      sound.ok()
      renderPanel()
    }

    function setSync(v: 'standard' | 'disabled', echo = true) {
      if (echo) term.echo(`zfs set sync=${v} tank/db`)
      syncProp = v
      latencies.length = 0
      renderPanel()
    }

    // ------------------------------------------------------------ terminal
    term.setHandler(
      (argv) => {
        const [cmd, sub, ...rest] = argv
        if (cmd === 'zpool' && sub === 'status') {
          term.print(
            formatStatus({
              pool: 'tank',
              state: 'ONLINE',
              vdevs: [{ name: 'mirror-0', state: 'ONLINE', children: [{ name: 'sda', state: 'ONLINE' }, { name: 'sdb', state: 'ONLINE' }] }],
              logs: slog ? [{ name: 'nvme0n1', state: 'ONLINE' }] : undefined,
            }),
          )
          return true
        }
        if (cmd === 'zpool' && sub === 'add') {
          if (rest[1] !== 'log' || !rest[2]) {
            term.print('In this lab: zpool add tank log nvme0n1', 'warn')
            return true
          }
          if (!allowSlog) {
            term.print('Ditto: patience! We\'ll add a log device in a moment.', 'warn')
            return true
          }
          if (slog) term.print(`/dev/${rest[2]} is part of active pool 'tank'`, 'err')
          else void addSlog(false)
          return true
        }
        if (cmd === 'zfs' && sub === 'get') {
          term.print(`NAME     PROPERTY  VALUE     SOURCE\ntank/db  sync      ${syncProp.padEnd(8)}  ${syncProp === 'standard' ? 'default' : 'local'}`)
          return true
        }
        if (cmd === 'zfs' && sub === 'set') {
          const m = (rest[0] ?? '').match(/^sync=(standard|disabled|always)$/)
          if (!m) term.print("In this lab you can set: sync=standard | sync=disabled", 'warn')
          else if (m[1] === 'always') term.print('# sync=always would send the uploader through the ZIL too. Try standard or disabled here.', 'dim')
          else if (!allowSyncToggle) term.print("Ditto: we'll get to that. It's a dangerous one!", 'warn')
          else setSync(m[1] as 'standard' | 'disabled', false)
          return true
        }
        return false
      },
      [
        'Commands in this chapter:',
        '  zpool status',
        '  zpool add tank log nvme0n1        add a SLOG device',
        '  zfs get sync tank/db',
        '  zfs set sync=disabled tank/db     (dangerous!)',
        '  zfs set sync=standard tank/db',
      ].join('\n'),
    )
    term.setSuggestions(['zpool status', 'zfs get sync tank/db'])
    let allowSlog = false
    let allowSyncToggle = false

    // -------------------------------------------------------------- script
    renderPanel()
    await ctx.fly(v3(-0.5, 12, 19), v3(-0.5, 0.8, 0.8), 2)
    ctx.objectives([
      { id: 'async', text: 'Watch async writes wait in RAM for the txg' },
      { id: 'sync', text: 'Watch a sync write go through the [[zil|ZIL]]' },
      { id: 'slog', text: 'Get fsync() latency under 1 ms' },
      { id: 'crash', text: 'Crash with writes in flight and replay the ZIL' },
      { id: 'disabled', text: 'Find out what sync=disabled really costs' },
    ])

    await ctx.next(
      'Two applications share this pool. On the left, an **uploader** that just writes, and a **database** that calls fsync() after every transaction. In the middle is RAM, where the open txg collects changes. On the right, the pool\'s disks.',
    )
    running = true
    upRate = 3
    ctx.say('Let\'s start the uploader. Watch its writes pile up in RAM and get flushed every 5 seconds.')
    await ctx.until(() => syncsDone >= 2)
    ctx.check('async')
    await ctx.next(
      'Async writes are acknowledged as soon as they\'re in RAM. They reach their final place with the next [[txg]]. A crash can lose the last few seconds, and that\'s fine: the uploader was never promised otherwise.',
    )

    dbRate = 1.4
    upRate = 1.5
    ctx.unlock('zil', 'sync')
    ctx.say('Now the database. Every commit is an fsync(): the data **must** be on stable storage before the call returns. Watch the yellow log records.')
    await ctx.until(() => latencies.length >= 4)
    ctx.check('sync')
    await ctx.next(
      'Waiting up to 5 seconds for the next txg would make every commit painfully slow. So ZFS writes a small record to the **ZFS Intent Log** right away, acknowledges, and moves on. The data still goes to its final place with the txg, after which the log record is thrown away. (Large sync writes on a pool without a SLOG go straight to their final place, and the log record just points at them.)',
    )
    await ctx.next(
      `Here the ZIL lives on the pool's spinning disks, and each fsync() waits for one: about **${avgLatency().toFixed(1)} ms**. Your database feels sluggish.`,
    )

    // SLOG
    allowSlog = true
    ctx.unlock('slog')
    hud.setActions([{ id: 'slog', label: 'Add a SLOG', cmd: 'zpool add tank log nvme0n1', kind: 'primary', glow: true, onClick: () => void addSlog() }])
    term.setSuggestions(['zpool add tank log nvme0n1', 'zpool status', 'zfs get sync tank/db'])
    ctx.say('Give the ZIL a fast, power-loss-protected NVMe device of its own: a **SLOG**. Press **Add a SLOG**, or type `zpool add tank log nvme0n1`.')
    await ctx.until(() => slogAdded)
    latencies.length = 0
    hud.setActions([])
    await ctx.until(() => latencies.length >= 5 && avgLatency() < 1)
    ctx.check('slog')
    await ctx.next(
      `fsync() latency dropped to about **${Math.round(avgLatency() * 1000)} µs**. Notice what did **not** change: data still flows from RAM to the pool disks with each txg. The SLOG is not a write cache. It's written constantly and read never, unless something goes wrong.`,
    )

    // Crash + replay
    hud.setActions([{ id: 'crash', label: 'Pull the plug', cmd: 'power failure', kind: 'danger', glow: true, onClick: () => void crash() }])
    ctx.say('So let\'s make something go wrong. Wait until there are yellow ZIL records on the SLOG, then **Pull the plug**.')
    await ctx.until(() => lastCrash.ackedSync > 0 && power === 'on' && !isOff())
    hud.setActions([])
    ctx.check('crash')
    await ctx.next(
      `On import, ZFS replayed the intent log: all **${lastCrash.recovered}** acknowledged sync writes since the last txg are back. The ${lastCrash.asyncLost} async writes in RAM are gone, but nobody had been promised they were safe.`,
    )

    // sync=disabled
    allowSyncToggle = true
    running = true
    hud.setActions([
      { id: 'dis', label: 'sync=disabled', cmd: 'zfs set sync=disabled tank/db', kind: 'danger', glow: true, onClick: () => setSync('disabled') },
      { id: 'crash', label: 'Pull the plug', cmd: 'power failure', kind: 'danger', hidden: true, onClick: () => void crash() },
    ])
    ctx.say(
      'Some tuning guides suggest `sync=disabled` for speed. Let\'s see why that\'s dangerous. Press **sync=disabled** (`zfs set sync=disabled tank/db`).',
    )
    await ctx.until(() => syncProp === 'disabled')
    hud.updateAction('dis', { hidden: true })
    lastCrash.ackedLost = 0
    await ctx.until(() => latencies.length >= 3)
    hud.updateAction('crash', { hidden: false })
    ctx.say('Blazing fast: fsync() returns instantly. Too good to be true? Wait a moment, then **Pull the plug** again.')
    await ctx.until(() => lastCrash.ackedLost > 0 && !isOff())
    hud.setActions([])
    ctx.check('disabled')
    await ctx.next(
      `**${lastCrash.ackedLost} writes the database was told were safe are gone.** The pool itself is perfectly consistent (thanks, copy-on-write), but the database now disagrees with its clients about what was committed. That's why sync=disabled is only for data you can afford to lose.`,
    )
    setSync('standard')
    running = true
    await ctx.next('Back to `sync=standard`. Remember: a SLOG makes sync writes fast **and** safe; disabling sync makes them fast and unsafe.', 'Take the checkpoint')
    running = false
    await ctx.finish()
  },
}
