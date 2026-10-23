import * as THREE from 'three'
import type { ChapterDef, Ctx } from './types'
import { BlockView, Platter, C, makeLabel, pulse, detach, v3 } from '../engine/kit'
import { h } from '../ui/dom'
import { Arc, Lru, type ArcList } from '../zfs/arc'

const CAP = 8
const S = 0.95
const ROW_Y = 3.2
const HOT = ['A', 'B', 'C', 'D', 'E', 'F']
const HOT_W = [0.26, 0.22, 0.18, 0.14, 0.11, 0.09]

interface Cube {
  key: string
  view: BlockView
  target: THREE.Vector3
  dying: boolean
}

export const chapter8: ChapterDef = {
  id: 'arc',
  num: 8,
  title: 'The ARC',
  tagline: 'Run the Adaptive Replacement Cache: MRU, MFU, ghost lists, and a backup job that tries to flush it all.',
  tags: ['ARC', 'MRU / MFU', 'ghost lists', 'L2ARC'],
  summary: [
    'The [[arc|ARC]] splits RAM between MRU (blocks seen once recently) and MFU (blocks seen again).',
    '[[ghost|Ghost lists]] remember evicted blocks, so the ARC learns which side deserves more room.',
    'One-time scans only churn MRU, leaving the MFU working set alone. That\'s scan resistance.',
    'An [[l2arc|L2ARC]] extends the cache onto SSDs for blocks that fall out of RAM.',
  ],
  quiz: [
    {
      q: 'A block read for the first time lands in…',
      options: ['MRU, the recently-used list', 'MFU, the frequently-used list', 'A ghost list', 'The L2ARC'],
      answer: 0,
      explain: 'New blocks enter MRU. Only a second hit while cached promotes a block to MFU.',
    },
    {
      q: 'What does a ghost list hold?',
      options: ['Headers of recently evicted blocks, without their data', 'Blocks waiting to be written', 'Blocks that failed their checksum', 'Deleted snapshots'],
      answer: 0,
      explain: 'A ghost costs a few bytes. It lets the ARC notice "I evicted this too soon" and rebalance.',
    },
    {
      q: 'A nightly backup reads 2 TB exactly once. Why does the ARC keep your hot data anyway?',
      options: [
        'One-time reads only churn MRU; repeatedly used blocks sit safely in MFU',
        'The ARC ignores reads from backup software',
        'Backups bypass RAM entirely',
        'The ARC is bigger than 2 TB',
      ],
      answer: 0,
      explain: 'A plain LRU cache would let the scan push out everything. The ARC\'s split protects frequently used blocks.',
    },
    {
      q: 'A hit on the MRU ghost list makes the ARC…',
      options: ['Give more of its space to MRU', 'Give more of its space to MFU', 'Flush the whole cache', 'Delete the ghost and do nothing'],
      answer: 0,
      explain: 'A recently evicted block was wanted again, so MRU was too small. The target p grows. An MFU ghost hit does the opposite.',
    },
  ],

  async run(ctx: Ctx) {
    const { stage, hud, term, sound, scope, root } = ctx
    stage.camera.position.set(0, 12, 28)
    stage.controls.target.set(0, 2.5, 0)

    // ---------------------------------------------------------------- scene
    const disk = new Platter(10, 2, 0.75, 'pool disks')
    disk.position.set(0, 0, -5)
    root.add(disk)
    const appMarker = makeLabel('<b>app</b> reads', 'big')
    appMarker.position.set(0, 0.4, 5.2)
    root.add(appMarker)
    const appPos = v3(0, 0.8, 5)

    // Cache window frame and p marker.
    const frameMat = new THREE.MeshBasicMaterial({ color: C.uber, transparent: true, opacity: 0.18, depthWrite: false })
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1, 1.25, 1.25), frameMat)
    frame.position.set(0, ROW_Y, 0)
    root.add(frame)
    const frameEdges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1.25, 1.25)), new THREE.LineBasicMaterial({ color: C.uber, transparent: true, opacity: 0.7 }))
    frame.add(frameEdges)
    const divider = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.6, 0.05), new THREE.MeshBasicMaterial({ color: '#ffffff' }))
    divider.position.set(0, ROW_Y, 0)
    root.add(divider)
    const pMarker = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.4, 3), new THREE.MeshBasicMaterial({ color: C.uber }))
    pMarker.position.set(0, ROW_Y - 1.05, 0)
    root.add(pMarker)
    const pLabel = makeLabel('', 'amber')
    pLabel.center.set(0.5, 0)
    root.add(pLabel)
    const regionLabels = {
      B1: makeLabel('B1 · MRU ghosts', 'faint'),
      T1: makeLabel('T1 · MRU', 'big blue'),
      T2: makeLabel('T2 · MFU', 'big mint'),
      B2: makeLabel('B2 · MFU ghosts', 'faint'),
    }
    for (const l of Object.values(regionLabels)) root.add(l)

    // L2ARC shelf, hidden until added.
    const l2 = new Platter(12, 1, 0.7, 'L2ARC · nvme1n1')
    l2.position.set(0, 0, 2.6)
    l2.visible = false
    root.add(l2)
    const l2Keys: string[] = []
    const L2CAP = 12

    // ---------------------------------------------------------------- model
    let arc = new Arc<string>(CAP)
    let lru = new Lru<string>(CAP)
    const cubes = new Map<string, Cube>()
    const l2Cubes = new Map<string, BlockView>()
    let l2Enabled = false
    let l2Hits = 0
    let reqCount = 0
    let ghostHits = 0
    let lastGhostHit: ArcList | null = null
    let promotions = 0
    let busy = false
    const recent = { arc: [] as number[], lru: [] as number[] }
    const scanStats = { arcHot: 0, arcHotHits: 0, lruHot: 0, lruHotHits: 0 }
    let scanning = false

    const colorFor = (key: string) => (key.startsWith('S') ? '#8fa0c0' : C.data)

    function cubeFor(key: string): Cube {
      let c = cubes.get(key)
      if (c && !c.dying) return c
      const view = new BlockView(colorFor(key), 0.7, 0.4)
      view.setLabel(key, '', 0.62)
      root.add(view)
      c = { key, view, target: new THREE.Vector3(), dying: false }
      cubes.set(key, c)
      stage.pick(view, {
        onHover: (on) => view.setHover(on),
        onClick: () => {
          if (manual && !busy) void request(key)
        },
        tooltip: () => {
          const w = arc.where(key)
          return `${key} · ${w === 'T1' ? 'in MRU (seen once)' : w === 'T2' ? 'in MFU (seen 2+ times)' : w === 'B1' ? 'MRU ghost: header only' : w === 'B2' ? 'MFU ghost: header only' : 'not cached'}${manual ? ' · click to read' : ''}`
        },
      })
      return c
    }

    function layout() {
      const t1 = arc.t1
      const t2 = arc.t2
      const pos = (list: ArcList, i: number) => {
        switch (list) {
          case 'T1':
            return v3(-(i + 0.5) * S, ROW_Y, 0)
          case 'T2':
            return v3((i + 0.5) * S, ROW_Y, 0)
          case 'B1':
            return v3(-(t1.length + i + 0.5) * S - 0.55, ROW_Y, 0)
          default:
            return v3((t2.length + i + 0.5) * S + 0.55, ROW_Y, 0)
        }
      }
      const seen = new Set<string>()
      ;(['T1', 'T2', 'B1', 'B2'] as ArcList[]).forEach((list) => {
        arc.list(list).forEach((key, i) => {
          const c = cubeFor(key)
          c.target.copy(pos(list, i))
          const ghost = list === 'B1' || list === 'B2'
          c.view.setOpacity(ghost ? 0.22 : 1)
          c.view.setColor(ghost ? C.ghost : colorFor(key))
          c.view.setGlow(ghost ? 0.05 : list === 'T2' ? 0.6 : 0.35)
          seen.add(key)
        })
      })
      for (const [key, c] of cubes) {
        if (seen.has(key) || c.dying) continue
        c.dying = true
        const start = c.view.position.clone()
        const end = start.clone().add(v3(0, -2.5, 0))
        void ctx
          .tween(0.6, (k) => {
            c.view.position.lerpVectors(start, end, k)
            c.view.setOpacity((1 - k) * 0.4)
          })
          .catch(() => {})
          .finally(() => {
            detach(c.view)
            c.view.mat.dispose()
            if (cubes.get(key) === c) cubes.delete(key)
          })
      }
      const left = t1.length * S
      const right = t2.length * S
      frame.scale.x = Math.max(0.05, left + right)
      frame.position.x = (right - left) / 2
      pMarker.position.x = -arc.p * S
      pLabel.position.set(-arc.p * S, ROW_Y - 1.35, 0)
      pLabel.element.textContent = `p = ${arc.p.toFixed(1)} (MRU target)`
      const mid = (list: ArcList, fallback: number) => {
        const n = arc.list(list).length
        if (!n) return fallback
        const a = pos(list, 0).x
        const b = pos(list, n - 1).x
        return (a + b) / 2
      }
      regionLabels.T1.position.set(mid('T1', -2), ROW_Y + 0.75, 0)
      regionLabels.T2.position.set(mid('T2', 2), ROW_Y + 0.75, 0)
      regionLabels.B1.position.set(mid('B1', -(t1.length + 1.5) * S - 0.6), ROW_Y + 0.75, 0)
      regionLabels.B2.position.set(mid('B2', (t2.length + 1.5) * S + 0.6), ROW_Y + 0.75, 0)
      renderPanel()
    }

    scope.onUpdate((dt) => {
      const k = 1 - Math.exp(-dt * 7)
      for (const c of cubes.values()) if (!c.dying) c.view.position.lerp(c.target, k)
    })

    function addToL2(key: string) {
      if (!l2Enabled || l2Keys.includes(key) || key.startsWith('S')) return
      l2Keys.unshift(key)
      while (l2Keys.length > L2CAP) {
        const old = l2Keys.pop()!
        const v = l2Cubes.get(old)
        if (v) {
          detach(v)
          v.mat.dispose()
          l2Cubes.delete(old)
        }
      }
      l2Keys.forEach((k2, i) => {
        let v = l2Cubes.get(k2)
        if (!v) {
          v = new BlockView(C.indirect, 0.45, 0.4)
          v.setLabel(k2, 'blue', 0.6)
          root.add(v)
          l2Cubes.set(k2, v)
        }
        v.position.copy(l2.worldSlot(i)).setY(0.55)
      })
    }

    async function request(key: string, fast = false) {
      busy = !fast
      reqCount++
      const before = arc.where(key)
      const res = arc.access(key)
      const lruRes = lru.access(key)
      const isHot = HOT.includes(key)
      if (scanning && isHot) {
        scanStats.arcHot++
        scanStats.lruHot++
        if (res.hit) scanStats.arcHotHits++
        if (lruRes.hit) scanStats.lruHotHits++
      }
      recent.arc.push(res.hit ? 1 : 0)
      recent.lru.push(lruRes.hit ? 1 : 0)
      if (recent.arc.length > 30) recent.arc.shift()
      if (recent.lru.length > 30) recent.lru.shift()
      if (before === 'T1' && res.hit) promotions++
      if (before === 'B1' || before === 'B2') {
        ghostHits++
        lastGhostHit = before
      }
      // Anything leaving the cache proper is a candidate for the L2ARC.
      for (const m of res.moves) if ((m.from === 'T1' || m.from === 'T2') && m.to !== 'T2' && m.to !== 'T1') addToL2(m.key)

      const c = cubeFor(key)
      const fromL2 = !res.hit && l2Enabled && l2Keys.includes(key)
      if (res.hit) {
        sound.read()
        layout()
        if (!fast) await pulse(scope, root, [appPos, c.target.clone()], C.ok, 0.35, 0.1)
        void c.view.flash(scope, C.ok, 0.35).catch(() => {})
      } else {
        if (fromL2) l2Hits++
        const src = fromL2 ? l2.worldSlot(l2Keys.indexOf(key)).setY(0.6) : disk.worldSlot(Math.floor(Math.random() * 20)).setY(0.4)
        if (!fast) await pulse(scope, root, [appPos, src], fromL2 ? C.indirect : C.bad, 0.3, 0.1)
        c.view.position.copy(src)
        if (before !== 'B1' && before !== 'B2') c.view.setOpacity(1)
        sound.tick()
        layout()
        if (!fast) await ctx.sleep(fromL2 ? 0.15 : 0.45)
      }
      busy = false
      return res
    }

    // ---------------------------------------------------------------- panel
    const rate = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) : 0)
    const arcBig = h('b', { class: 'mono', style: { fontSize: '22px' } }, '—')
    const lruBig = h('b', { class: 'mono', style: { fontSize: '22px', color: 'var(--fg-dim)' } }, '—')
    const scanEl = h('div', { class: 'note', style: { marginTop: '4px' } })
    const keysEl = h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '8px' } })
    let manual = false
    const panel = h(
      'div',
      null,
      h('h3', null, 'Hit rate · last 30 reads'),
      h(
        'div',
        { style: { display: 'flex', gap: '24px', alignItems: 'baseline' } },
        h('div', null, arcBig, h('div', { class: 'note', style: { margin: '0' } }, 'ARC')),
        h('div', null, lruBig, h('div', { class: 'note', style: { margin: '0' } }, 'plain LRU, same reads')),
      ),
      scanEl,
      h('h3', { style: { marginTop: '12px' } }, 'Read a block'),
      keysEl,
    )
    hud.info(panel)

    function renderKeys() {
      keysEl.replaceChildren(
        ...['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K'].map((k) =>
          h('button', { class: 'btn', style: { minWidth: '38px', padding: '6px 8px' }, disabled: !manual, onclick: () => !busy && void request(k) }, k),
        ),
      )
    }

    function renderPanel() {
      arcBig.textContent = recent.arc.length ? `${rate(recent.arc)}%` : '—'
      lruBig.textContent = recent.lru.length ? `${rate(recent.lru)}%` : '—'
      scanEl.textContent = scanStats.arcHot
        ? `During the backup, hot-set reads hit ${Math.round((scanStats.arcHotHits / scanStats.arcHot) * 100)}% of the time in the ARC vs ${Math.round((scanStats.lruHotHits / scanStats.lruHot) * 100)}% in LRU.`
        : ''
      hud.stats([
        { k: 'reads', v: String(reqCount) },
        { k: 'p', v: arc.p.toFixed(1), narrowHide: true },
        ...(l2Enabled ? [{ k: 'L2 hits', v: String(l2Hits), kind: 'ok' as const }] : []),
      ])
    }

    // ------------------------------------------------------------- workloads
    async function runWorkload(n: number, gen: (i: number) => string, interval = 0.28) {
      for (let i = 0; i < n; i++) {
        void request(gen(i), true)
        await ctx.sleep(interval)
      }
    }
    const hotKey = () => {
      let r = Math.random()
      for (let i = 0; i < HOT.length; i++) {
        r -= HOT_W[i]
        if (r <= 0) return HOT[i]
      }
      return HOT[0]
    }

    // ------------------------------------------------------------ terminal
    let l2Allowed = false
    term.setHandler(
      (argv) => {
        const [cmd, sub, ...rest] = argv
        if (cmd === 'arc_summary' || cmd === 'arcstat' || (cmd === 'cat' && (sub ?? '').includes('arcstats'))) {
          term.print(
            [
              'ARC size (current):        ' + `${arc.t1.length + arc.t2.length} of ${CAP} blocks`,
              `        MRU (T1) size:     ${arc.t1.length}`,
              `        MFU (T2) size:     ${arc.t2.length}`,
              `        MRU ghost (B1):    ${arc.b1.length}`,
              `        MFU ghost (B2):    ${arc.b2.length}`,
              `        Target MRU (p):    ${arc.p.toFixed(2)}`,
              `ARC hits:                  ${arc.hits}`,
              `ARC misses:                ${arc.misses}`,
              `Hit ratio:                 ${(arc.hitRate * 100).toFixed(1)} %`,
              ...(l2Enabled ? [`L2ARC hits:                ${l2Hits}`] : []),
            ].join('\n'),
          )
          return true
        }
        if (cmd === 'zpool' && sub === 'add') {
          if (rest[1] !== 'cache') term.print('In this lab: zpool add tank cache nvme1n1', 'warn')
          else if (!l2Allowed) term.print('Ditto: we\'ll get to the L2ARC shortly.', 'warn')
          else if (!l2Enabled) addL2(false)
          else term.print(`/dev/${rest[2] ?? 'nvme1n1'} is part of active pool 'tank'`, 'err')
          return true
        }
        return false
      },
      ['Commands in this chapter:', '  arc_summary                  ARC sizes, hits and misses', '  zpool add tank cache nvme1n1  add an L2ARC device'].join('\n'),
    )
    term.setSuggestions(['arc_summary'])

    function addL2(echo = true) {
      if (echo) term.echo('zpool add tank cache nvme1n1')
      l2Enabled = true
      l2.visible = true
      sound.ok()
      renderPanel()
    }

    // -------------------------------------------------------------- script
    layout()
    renderKeys()
    await ctx.fly(v3(0, 9, 17), v3(0, 2.2, 0), 2)
    ctx.objectives([
      { id: 'twice', text: 'Read a block twice and watch it move to MFU' },
      { id: 'fill', text: 'Run a working set until blocks get evicted' },
      { id: 'ghost', text: 'Hit a ghost and watch the ARC adapt' },
      { id: 'scan', text: 'Keep the hot set cached through a backup scan' },
      { id: 'l2', text: 'Serve a read from the [[l2arc|L2ARC]]' },
    ])
    ctx.unlock('arc')

    await ctx.next(
      'This is the [[arc|ARC]], ZFS\'s cache in RAM, shrunk to 8 blocks so we can watch it think. Reads come from the app at the front; misses have to go to the slow pool disks at the back.',
    )
    manual = true
    renderKeys()
    ctx.say('The left half is **MRU** (blocks seen once recently), the right half **MFU** (seen at least twice). Read block **A** with the buttons on the right.')
    await ctx.until(() => arc.where('A') === 'T1')
    ctx.say('A miss: A came up from disk into MRU. Now read **A again**.')
    await ctx.until(() => arc.where('A') === 'T2')
    ctx.check('twice')
    await ctx.next('A hit, and A moved to MFU. A block earns its place in MFU by being used more than once.')

    // Fill
    manual = false
    renderKeys()
    await ctx.next('Let\'s run a working set: blocks A to F, some used much more than others, plus a few one-off reads.', 'Run it')
    await runWorkload(40, (i) => (i % 5 === 4 ? `${'GHJK'[(i / 5) % 4 | 0]}` : hotKey()))
    await ctx.sleep(0.6)
    ctx.check('fill')
    ctx.unlock('ghost')
    await ctx.next(
      'The cache filled up, so blocks had to be evicted. Evicted blocks leave **ghosts** behind (the faint cubes at the far ends): just the header, no data. B1 holds ghosts from MRU, B2 ghosts from MFU.',
    )

    // Ghost hit
    manual = true
    renderKeys()
    const g0 = ghostHits
    const pBefore = arc.p
    const ghostKeys = () => [...arc.b1, ...arc.b2]
    if (ghostKeys().length === 0) {
      await runWorkload(6, (i) => `${'GHJKLM'[i]}`)
    }
    ctx.say(`Click a **ghost** (or read it with the buttons). It's a miss, since the data is gone, but the ARC learns from it. Watch the amber **p** marker.`)
    await ctx.until(() => ghostHits > g0)
    await ctx.sleep(0.6)
    ctx.check('ghost')
    await ctx.next(
      lastGhostHit === 'B1'
        ? `An MRU ghost hit: "I evicted a recent block too soon." The ARC moved its target **p** from ${pBefore.toFixed(1)} to ${arc.p.toFixed(1)}, giving MRU more room. A hit in B2 would push the other way.`
        : `An MFU ghost hit: "I evicted a frequent block too soon." The ARC lowered its MRU target **p** from ${pBefore.toFixed(1)} to ${arc.p.toFixed(1)}, giving MFU more room. A hit in B1 would push the other way.`,
    )

    // Backup scan
    manual = false
    renderKeys()
    for (let i = 0; i < 12; i++) await request(hotKey(), true)
    await ctx.next(
      'Now the nightly backup kicks in: it reads 36 cold blocks (S1, S2, …) exactly once each, while the app keeps using its hot set. The panel compares the ARC with a plain LRU cache fed the very same reads.',
      'Start the backup',
    )
    scanning = true
    let s = 1
    await runWorkload(54, (i) => (i % 3 === 2 ? hotKey() : `S${s++}`), 0.24)
    scanning = false
    await ctx.sleep(0.6)
    const arcHot = scanStats.arcHot ? scanStats.arcHotHits / scanStats.arcHot : 0
    const lruHot = scanStats.lruHot ? scanStats.lruHotHits / scanStats.lruHot : 0
    ctx.check('scan')
    await ctx.next(
      `The scan churned through MRU and fell off the end, while the hot blocks sat safely in MFU: **${Math.round(arcHot * 100)}%** of hot reads still hit. LRU, which only knows "recent", let the scan push the hot set out: **${Math.round(lruHot * 100)}%**. That's scan resistance.`,
    )

    // L2ARC
    l2Allowed = true
    ctx.unlock('l2arc')
    hud.setActions([{ id: 'l2', label: 'Add an L2ARC', cmd: 'zpool add tank cache nvme1n1', kind: 'primary', glow: true, onClick: () => addL2() }])
    term.setSuggestions(['zpool add tank cache nvme1n1', 'arc_summary'])
    ctx.say('RAM is precious. An [[l2arc|L2ARC]] adds an SSD as a second-level cache for blocks that fall out of RAM. Press **Add an L2ARC**.')
    await ctx.until(() => l2Enabled)
    hud.setActions([])
    await ctx.next('Blocks about to be evicted from RAM now get copied to the L2ARC shelf. Let\'s churn the cache a little.', 'Run it')
    await runWorkload(30, (i) => (i % 2 ? hotKey() : `${'GHJKLMNP'[i % 8]}`), 0.22)
    manual = true
    renderKeys()
    const l2Before = l2Hits
    ctx.say(`Now read a block that's on the **L2ARC** shelf but not in RAM (${l2Keys.filter((k) => !arc.t1.includes(k) && !arc.t2.includes(k)).slice(0, 3).join(', ') || 'try G, H, J or K'}). It comes back from the SSD instead of the slow disks.`)
    await ctx.until(() => l2Hits > l2Before)
    await ctx.sleep(0.5)
    ctx.check('l2')
    await ctx.next(
      'Served from the SSD in a fraction of a disk seek. The L2ARC isn\'t free: every block cached there needs a small header in RAM. Since OpenZFS 2.0 it survives reboots, so it doesn\'t start cold.',
      'Take the checkpoint',
    )
    await ctx.finish()
  },
}
