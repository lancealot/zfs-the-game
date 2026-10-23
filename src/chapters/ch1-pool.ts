import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import type { ChapterDef, Ctx } from './types'
import { DriveView, C, makeLabel, burst, detach, v3 } from '../engine/kit'
import { Ease } from '../engine/anim'
import { h } from '../ui/dom'
import {
  type VdevSpec,
  type VdevType,
  type DiskSpec,
  poolStats,
  poolState,
  vdevState,
  vdevNames,
  vdevTolerance,
  vdevUsableTB,
  validateVdev,
  replicationMismatch,
} from '../zfs/pool'
import { formatStatus, SEE, type StatusDev } from '../zfs/status'
import { fmtSize, TB } from '../zfs/units'

const POOL = 'tank'
const DISK_TB = 4
const TYPES: VdevType[] = ['disk', 'mirror', 'raidz1', 'raidz2', 'raidz3']

interface Drive {
  spec: DiskSpec
  view: DriveView
  home: THREE.Vector3
  selected: boolean
}

export const chapter1: ChapterDef = {
  id: 'pool',
  num: 1,
  title: 'Pool Architect',
  tagline: 'Turn eight bare disks into a pool. Mirrors, RAIDZ, and what happens when disks die.',
  tags: ['zpool create', 'vdev', 'mirror', 'raidz'],
  summary: [
    'A [[pool]] stripes data across its top-level [[vdev|vdevs]]. Redundancy lives inside each vdev.',
    'An n-way [[mirror]] survives n−1 failures; [[raidz|RAIDZ1/2/3]] survive 1/2/3 per vdev.',
    'Lose any whole vdev and the entire pool is lost.',
    'More vdevs means more random IOPS; wider RAIDZ means better space efficiency.',
  ],
  quiz: [
    {
      q: 'A pool has two RAIDZ1 vdevs. One disk fails in **each** vdev. What state is the pool in?',
      options: [
        'DEGRADED, but every block is still readable',
        'Lost: two disks failed, and RAIDZ1 only survives one',
        'ONLINE: ZFS instantly moves data to spare space',
        'UNAVAIL until both disks are replaced',
      ],
      answer: 0,
      explain:
        'Each RAIDZ1 vdev tolerates one failed disk on its own. Failures in different vdevs don\'t add up; only a vdev that loses more than its parity can sink the pool.',
    },
    {
      q: 'Where does redundancy live in a ZFS pool?',
      options: [
        'Inside each vdev: its mirror copies or RAIDZ parity',
        'At the pool level, which mirrors data between vdevs',
        'In the uberblock',
        'In the ARC',
      ],
      answer: 0,
      explain: 'The pool stripes data across top-level vdevs and has no redundancy of its own. Lose any whole vdev and the pool goes with it.',
    },
    {
      q: 'You build a RAIDZ1 vdev from three 4 TB disks. Roughly how much data can it hold?',
      options: ['8 TB', '12 TB', '4 TB', '6 TB'],
      answer: 0,
      explain: '(disks − parity) × disk size = (3 − 1) × 4 TB. Real usable space is a little lower after metadata, padding and slop space.',
    },
    {
      q: 'Which layout of 8 disks gives the most random IOPS?',
      options: ['Four 2-way mirrors', 'One 8-disk RAIDZ2', 'Two 4-disk RAIDZ1 vdevs', 'One 8-way mirror'],
      answer: 0,
      explain:
        'Random IOPS scale with the number of top-level vdevs, since each RAIDZ vdev behaves like roughly one disk. An 8-way mirror reads fast but writes like a single disk.',
    },
  ],

  async run(ctx: Ctx) {
    const { stage, hud, term, sound, root, scope } = ctx
    stage.camera.position.set(0, 16, 26)
    stage.controls.target.set(0, 0, 1)

    // ------------------------------------------------------------ scene
    const shelfZ = 5.6
    const poolZ = -2.4
    const shelf = new THREE.Mesh(
      new RoundedBoxGeometry(13.6, 0.3, 2.6, 2, 0.08),
      new THREE.MeshStandardMaterial({ color: C.steel, metalness: 0.6, roughness: 0.45 }),
    )
    shelf.position.set(0, 0.15, shelfZ)
    shelf.receiveShadow = true
    root.add(shelf)
    const shelfLabel = makeLabel('Unassigned drives', 'platter')
    shelfLabel.position.set(0, 0.3, shelfZ + 1.9)
    shelfLabel.center.set(0.5, 0)
    root.add(shelfLabel)

    const poolLabel = makeLabel('', 'title')
    poolLabel.position.set(0, 3.4, poolZ)
    root.add(poolLabel)

    const drives: Drive[] = []
    for (let i = 0; i < 8; i++) {
      const name = `sd${String.fromCharCode(97 + i)}`
      const view = new DriveView(name, `${DISK_TB} TB`)
      const home = v3((i - 3.5) * 1.6, 0.3, shelfZ)
      view.position.copy(home)
      root.add(view)
      const d: Drive = { spec: { name, sizeTB: DISK_TB }, view, home, selected: false }
      drives.push(d)
      stage.pick(view, {
        onHover: (on) => view.setHover(on),
        tooltip: () => tooltipFor(d),
        onClick: () => clickDrive(d),
      })
    }
    const byName = new Map(drives.map((d) => [d.spec.name, d]))

    // ------------------------------------------------------------ state
    let vdevs: VdevSpec[] = []
    const failed = new Set<string>()
    let mode: 'build' | 'pull' | 'locked' = 'locked'
    let pickType: VdevType = 'mirror'
    let version = 0
    const platforms: THREE.Object3D[] = []

    const inPool = (name: string) => vdevs.some((v) => v.disks.some((d) => d.name === name))
    const selected = () => drives.filter((d) => d.selected)

    function tooltipFor(d: Drive) {
      const name = d.spec.name
      if (inPool(name)) {
        if (mode === 'pull') return failed.has(name) ? `${name}: click to plug it back in` : `${name}: click to pull it out`
        return `${name}: part of pool ${POOL}`
      }
      if (mode === 'build') return `${name} · ${DISK_TB} TB HDD · click to ${d.selected ? 'deselect' : 'select'}`
      return `${name} · ${DISK_TB} TB HDD`
    }

    function clickDrive(d: Drive) {
      const name = d.spec.name
      if (inPool(name)) {
        if (mode !== 'pull') {
          hud.toast(mode === 'build' ? 'That drive is already in the pool.' : 'Not yet!')
          return
        }
        if (failed.has(name)) reinsert(name)
        else pull(name)
        return
      }
      if (mode !== 'build') {
        hud.toast('Drives are locked for this step.')
        return
      }
      d.selected = !d.selected
      d.view.setSelected(d.selected)
      sound.tick()
      renderPanel()
    }

    // ----------------------------------------------------------- layout
    function layout() {
      for (const p of platforms) {
        detach(p)
        p.traverse((o) => {
          const m = o as THREE.Mesh
          m.geometry?.dispose()
          ;(m.material as THREE.Material | undefined)?.dispose?.()
        })
      }
      platforms.length = 0
      const names = vdevNames(vdevs)
      const pitchX = 1.55
      const pitchZ = 2.1
      const widths = vdevs.map((v) => Math.min(4, v.disks.length) * pitchX + 0.5)
      const gap = 0.7
      const total = widths.reduce((a, b) => a + b, 0) + gap * Math.max(0, vdevs.length - 1)
      let x = -total / 2
      const pstate = poolState(vdevs, failed)
      vdevs.forEach((v, vi) => {
        const w = widths[vi]
        const rows = Math.ceil(v.disks.length / 4)
        const depth = rows * pitchZ + 0.3
        const cx = x + w / 2
        const st = vdevState(v, failed)
        const tint = st === 'UNAVAIL' ? '#3a1218' : st === 'DEGRADED' ? '#3a2a10' : v.type === 'mirror' ? '#16233f' : v.type === 'disk' ? '#1f2433' : '#241a3d'
        const slab = new THREE.Mesh(
          new RoundedBoxGeometry(w, 0.28, depth, 2, 0.08),
          new THREE.MeshStandardMaterial({ color: tint, metalness: 0.5, roughness: 0.5, emissive: tint, emissiveIntensity: 0.4 }),
        )
        slab.position.set(cx, 0.14, poolZ)
        slab.receiveShadow = true
        const group = new THREE.Group()
        group.add(slab)
        const stClass = st === 'UNAVAIL' ? 'bad' : st === 'DEGRADED' ? 'amber' : v.type === 'mirror' ? 'blue' : 'violet'
        const lbl = makeLabel(`<b>${names[vi]}</b> ${st === 'ONLINE' ? '' : st}`, `big ${stClass}`)
        lbl.position.set(cx, 1.15, poolZ - depth / 2 - 0.1)
        group.add(lbl)
        root.add(group)
        platforms.push(group)
        v.disks.forEach((d, di) => {
          const drive = byName.get(d.name)!
          const col = di % 4
          const row = Math.floor(di / 4)
          const ncols = Math.min(4, v.disks.length)
          const target = v3(cx + (col - (ncols - 1) / 2) * pitchX, 0.28, poolZ + (row - (rows - 1) / 2) * pitchZ)
          moveDrive(drive, target)
        })
        x += w + gap
      })
      for (const d of drives) if (!inPool(d.spec.name)) moveDrive(d, d.home)
      poolLabel.element.innerHTML = vdevs.length
        ? `pool <span style="color:var(--amber)">${POOL}</span> · <span style="color:${pstate === 'ONLINE' ? 'var(--mint)' : pstate === 'DEGRADED' ? 'var(--amber)' : 'var(--red)'}">${pstate}</span>`
        : ''
      poolLabel.position.set(0, 3.4, poolZ)
      renderStats()
      renderPanel()
    }

    const flights = new Map<Drive, number>()
    function moveDrive(d: Drive, target: THREE.Vector3) {
      const isFailed = failed.has(d.spec.name)
      const dest = target.clone()
      if (isFailed) dest.y -= 0.12
      const from = d.view.position.clone()
      const rotFrom = d.view.rotation.z
      const rotTo = isFailed ? 0.22 : 0
      if (from.distanceTo(dest) < 0.01 && Math.abs(rotFrom - rotTo) < 0.01) return
      const id = (flights.get(d) ?? 0) + 1
      flights.set(d, id)
      const lift = from.distanceTo(dest) > 1 ? 2.2 : 0
      scope
        .tween(
          0.7,
          (k) => {
            if (flights.get(d) !== id) return
            d.view.position.lerpVectors(from, dest, k)
            d.view.position.y += Math.sin(k * Math.PI) * lift
            d.view.rotation.z = rotFrom + (rotTo - rotFrom) * k
          },
          Ease.inOut,
        )
        .catch(() => {})
    }

    // ------------------------------------------------------------ actions
    function addVdevs(specs: Array<{ type: VdevType; names: string[] }>, force: boolean, fromCli: boolean): boolean {
      for (const s of specs) {
        const err = validateVdev(s.type, s.names.length)
        if (err) {
          term.print(err, 'err')
          if (!fromCli) hud.toast(err.replace('invalid vdev specification: ', ''), 'bad')
          return false
        }
        for (const n of s.names) {
          if (!byName.has(n)) {
            term.print(`cannot open '${n}': no such device in /dev`, 'err')
            return false
          }
          if (inPool(n)) {
            term.print(`/dev/${n} is part of active pool '${POOL}'`, 'err')
            return false
          }
        }
      }
      const all = specs.flatMap((s) => s.names)
      if (new Set(all).size !== all.length) {
        term.print('invalid vdev specification: a device was listed twice', 'err')
        return false
      }
      // zpool checks replication consistency across everything in the command and the pool.
      const existing = [...vdevs]
      for (const s of specs) {
        const mm = replicationMismatch(existing, s.type, s.names.length)
        if (mm && !force) {
          term.print("invalid vdev specification\nuse '-f' to override the following errors:\n" + mm, 'err')
          if (!fromCli) hud.toast('zpool refuses to mix redundancy levels without -f', 'bad')
          return false
        }
        if (mm) term.print(`warning: ${mm} (forced with -f)`, 'warn')
        existing.push({ type: s.type, disks: s.names.map((n) => byName.get(n)!.spec) })
      }
      const firstCreate = vdevs.length === 0
      vdevs = existing
      for (const d of drives) {
        d.selected = false
        d.view.setSelected(false)
      }
      if (firstCreate) term.print('# ashift=12 (4 KiB sectors) detected and set for each vdev', 'dim')
      sound.write()
      for (const s of specs) for (const n of s.names) burst(scope, root, byName.get(n)!.view.position.clone().setY(1), C.uber, 14, 1)
      version++
      layout()
      return true
    }

    function uiAddVdev() {
      const sel = selected().map((d) => d.spec.name)
      if (sel.length === 0) {
        hud.toast('Select drives on the shelf first.')
        return
      }
      const specs = pickType === 'disk' ? sel.map((n) => ({ type: 'disk' as VdevType, names: [n] })) : [{ type: pickType, names: sel }]
      const err = validateVdev(pickType, sel.length)
      if (err) {
        hud.toast(err.replace('invalid vdev specification: ', ''), 'bad')
        sound.bad()
        return
      }
      let force = false
      const probe = [...vdevs]
      for (const s of specs) {
        if (replicationMismatch(probe, s.type, s.names.length)) force = true
        probe.push({ type: s.type, disks: [] })
      }
      const verb = vdevs.length === 0 ? 'create' : 'add'
      const specText = specs.map((s) => (s.type === 'disk' ? s.names[0] : `${s.type} ${s.names.join(' ')}`)).join(' ')
      term.echo(`zpool ${verb}${force ? ' -f' : ''} ${POOL} ${specText}`)
      addVdevs(specs, force, false)
    }

    function destroyPool(echo = true) {
      if (vdevs.length === 0) return
      if (echo) term.echo(`zpool destroy ${POOL}`)
      vdevs = []
      failed.clear()
      for (const d of drives) d.view.setState('ok')
      version++
      layout()
    }

    function pull(name: string) {
      failed.add(name)
      const d = byName.get(name)!
      d.view.setState('bad')
      sound.zap()
      burst(scope, root, d.view.position.clone().setY(0.8), C.bad, 30, 1.3)
      term.print(`# you yank ${name} out of its drive bay`, 'dim')
      version++
      layout()
      showStatus()
    }

    function reinsert(name: string) {
      failed.delete(name)
      byName.get(name)!.view.setState('ok')
      term.print(`# ${name} plugged back in; ZFS resilvers what it missed`, 'dim')
      sound.write()
      version++
      layout()
    }

    // -------------------------------------------------------- status/text
    function statusModel() {
      const names = vdevNames(vdevs)
      const pstate = poolState(vdevs, failed)
      const devs: StatusDev[] = vdevs.map((v, i) => {
        const st = vdevState(v, failed)
        const leaves = v.disks.map((d) => ({
          name: d.name,
          state: failed.has(d.name) ? 'UNAVAIL' : 'ONLINE',
          note: failed.has(d.name) ? 'cannot open' : undefined,
        }))
        if (v.type === 'disk') return leaves[0]
        return { name: names[i], state: st, note: st === 'UNAVAIL' ? 'insufficient replicas' : undefined, children: leaves }
      })
      let status: string | undefined
      let action: string | undefined
      let see: string | undefined
      if (pstate === 'DEGRADED') {
        status = 'One or more devices could not be opened.  Sufficient replicas exist for\nthe pool to continue functioning in a degraded state.'
        action = "Attach the missing device and online it using 'zpool online'."
        see = SEE('ZFS-8000-2Q')
      } else if (pstate === 'UNAVAIL') {
        status = 'One or more devices are faulted in response to IO failures.'
        action = "Make sure the affected devices are connected, then run 'zpool clear'."
        see = SEE('ZFS-8000-HC')
      }
      return formatStatus({ pool: POOL, state: pstate, status, action, see, vdevs: devs })
    }

    function showStatus(echo = true) {
      if (echo) term.echo(`zpool status ${POOL}`)
      if (vdevs.length === 0) term.print(`cannot open '${POOL}': no such pool`, 'err')
      else term.print(statusModel())
    }

    function zpoolList() {
      if (vdevs.length === 0) return term.print('no pools available')
      // zpool list reports raw space for RAIDZ (parity included) but usable space for mirrors.
      const size = vdevs.reduce((s, v) => s + (v.type.startsWith('raidz') ? v.disks.length * DISK_TB : vdevUsableTB(v)), 0) * TB
      const head = 'NAME   SIZE  ALLOC   FREE  CKPOINT  EXPANDSZ   FRAG    CAP  DEDUP    HEALTH  ALTROOT'
      const row = `${POOL.padEnd(4)}  ${fmtSize(size).padStart(5)}   612K  ${fmtSize(size).padStart(5)}        -         -     0%     0%  1.00x  ${poolState(vdevs, failed).padStart(8)}  -`
      term.print(`${head}\n${row}`)
    }

    function zfsList() {
      if (vdevs.length === 0) return term.print('no datasets available')
      const usable = poolStats(vdevs).usableTB * TB
      const avail = usable * (1 - 1 / 32) // slop space reserve
      term.print(`NAME   USED  AVAIL  REFER  MOUNTPOINT\n${POOL}   480K  ${fmtSize(avail).padStart(5)}    96K  /${POOL}`)
    }

    // ------------------------------------------------------------- panel
    const statEls = {
      usable: h('b'),
      usableFill: h('div', { class: 'fill' }),
      tol: h('b'),
      tolFill: h('div', { class: 'fill', style: { background: 'var(--mint)' } }),
      iops: h('b'),
      iopsFill: h('div', { class: 'fill', style: { background: 'var(--blue)' } }),
      preview: h('div', { class: 'note', style: { marginTop: '6px' } }),
      sel: h('div', { class: 'note', style: { marginTop: '6px' } }),
    }
    const picker = h('div', { class: 'seg-picker', role: 'group', 'aria-label': 'Vdev type' })
    const addBtn = h('button', { class: 'btn primary', style: { width: '100%', marginTop: '8px' }, onclick: () => uiAddVdev() }, 'Add vdev')
    const buildBox = h('div', null, h('h3', null, 'Vdev type'), picker, statEls.sel, statEls.preview, addBtn)
    const meter = (label: string, val: HTMLElement, fill: HTMLElement) =>
      h('div', { class: 'meter' }, h('div', { class: 'lab' }, h('span', null, label), val), h('div', { class: 'track' }, fill))
    const panel = h(
      'div',
      null,
      buildBox,
      h('h3', { style: { marginTop: '14px' } }, `Pool "${POOL}"`),
      meter('Usable capacity', statEls.usable, statEls.usableFill),
      meter('Survives any', statEls.tol, statEls.tolFill),
      meter('Random write IOPS', statEls.iops, statEls.iopsFill),
    )
    hud.info(panel)

    function renderPanel() {
      picker.replaceChildren(
        ...TYPES.map((t) =>
          h(
            'button',
            {
              class: t === pickType ? 'on' : '',
              'aria-pressed': String(t === pickType),
              disabled: mode !== 'build',
              onclick: () => {
                pickType = t
                sound.tick()
                renderPanel()
              },
            },
            t,
          ),
        ),
      )
      buildBox.style.opacity = mode === 'build' ? '1' : '0.45'
      const sel = selected()
      statEls.sel.textContent = sel.length ? `Selected: ${sel.map((d) => d.spec.name).join(' ')}` : 'Click drives on the shelf to select them.'
      const n = sel.length
      const err = n ? validateVdev(pickType, n) : null
      if (!n) statEls.preview.textContent = ''
      else if (err) statEls.preview.textContent = `${pickType} needs at least ${err.match(/(\d+)/)?.[1]} disks.`
      else if (pickType === 'disk') statEls.preview.textContent = `${n} single-disk vdev${n > 1 ? 's' : ''}: ${n * DISK_TB} TB, no redundancy.`
      else {
        const v: VdevSpec = { type: pickType, disks: sel.map((d) => d.spec) }
        statEls.preview.textContent = `${pickType} of ${n}: ${vdevUsableTB(v)} TB usable, survives ${vdevTolerance(v)} failure${vdevTolerance(v) === 1 ? '' : 's'}.`
      }
      addBtn.disabled = mode !== 'build' || n === 0
      addBtn.textContent = vdevs.length ? 'Add vdev to pool' : 'Create pool'
    }

    function renderStats() {
      const st = poolStats(vdevs)
      statEls.usable.textContent = vdevs.length ? `${st.usableTB} TB of ${st.rawTB} TB` : '—'
      statEls.usableFill.style.width = `${(st.usableTB / 32) * 100}%`
      statEls.tol.textContent = vdevs.length ? `${st.tolerance} disk failure${st.tolerance === 1 ? '' : 's'}` : '—'
      statEls.tolFill.style.width = `${(st.tolerance / 3) * 100}%`
      statEls.iops.textContent = vdevs.length ? `≈ ${st.writeIops} (${st.vdevCount} vdev${st.vdevCount === 1 ? '' : 's'})` : '—'
      statEls.iopsFill.style.width = `${(st.vdevCount / 8) * 100}%`
      const ps = vdevs.length ? poolState(vdevs, failed) : null
      hud.stats([
        { k: 'pool', v: ps ? `${POOL} ${ps}` : 'none', kind: ps === 'ONLINE' ? 'ok' : ps === 'DEGRADED' ? 'warn' : ps ? 'bad' : undefined },
        { k: 'disks used', v: `${vdevs.reduce((s, v) => s + v.disks.length, 0)}/8`, narrowHide: true },
      ])
    }

    hud.setActions([
      { id: 'status', label: 'Status', cmd: 'zpool status', onClick: () => showStatus() },
      { id: 'destroy', label: 'Destroy pool', cmd: `zpool destroy ${POOL}`, kind: 'danger', onClick: () => destroyPool() },
    ])

    // ----------------------------------------------------------- terminal
    term.setHandler(
      (argv) => {
        const [cmd, sub, ...rest] = argv
        if (cmd === 'lsblk') {
          term.print(['NAME  SIZE TYPE', ...drives.map((d) => `${d.spec.name.padEnd(5)} 3.6T disk${inPool(d.spec.name) ? `  (${POOL})` : ''}`)].join('\n'))
          return true
        }
        if (cmd !== 'zpool' && cmd !== 'zfs') return false
        if (cmd === 'zfs') {
          if (sub === 'list') {
            zfsList()
            return true
          }
          return false
        }
        if (sub === 'status') {
          showStatus(false)
          return true
        }
        if (sub === 'list') {
          zpoolList()
          return true
        }
        if (sub === 'destroy') {
          if (rest[0] !== POOL) term.print(`cannot open '${rest[0] ?? ''}': no such pool`, 'err')
          else if (vdevs.length === 0) term.print(`cannot open '${POOL}': no such pool`, 'err')
          else if (mode === 'locked') term.print('Hang on, Ditto is still using that pool.', 'warn')
          else destroyPool(false)
          return true
        }
        if (sub === 'create' || sub === 'add') {
          const force = rest.includes('-f')
          const args = rest.filter((a) => a !== '-f')
          const [pool, ...spec] = args
          if (mode !== 'build') {
            term.print("Ditto: hold on, I'm still explaining! Press Next first.", 'warn')
            return true
          }
          if (sub === 'create' && vdevs.length) {
            term.print(`cannot create '${pool}': pool already exists`, 'err')
            return true
          }
          if (sub === 'add' && !vdevs.length) {
            term.print(`cannot open '${pool}': no such pool`, 'err')
            return true
          }
          if (pool !== POOL) {
            term.print(`In this lab the pool is called '${POOL}'. Try: zpool ${sub} ${POOL} mirror sda sdb`, 'warn')
            return true
          }
          const parsed = parseSpec(spec)
          if (typeof parsed === 'string') {
            term.print(parsed, 'err')
            return true
          }
          addVdevs(parsed, force, true)
          return true
        }
        if (sub === 'offline' || sub === 'online') {
          term.print('In this chapter, click a pool drive to pull it out or plug it back in.', 'warn')
          return true
        }
        return false
      },
      [
        'Commands in this chapter:',
        '  zpool create tank mirror sda sdb     create a pool from one 2-disk mirror',
        '  zpool create tank raidz2 sda sdb sdc sdd',
        '  zpool add tank mirror sdc sdd        add another vdev to the pool',
        '  zpool status | zpool list | zfs list',
        '  zpool destroy tank                   start over',
        '  lsblk                                list the drives',
      ].join('\n'),
    )
    term.setSuggestions(['zpool status', 'zpool list', 'zfs list', 'lsblk'])

    function parseSpec(tokens: string[]): Array<{ type: VdevType; names: string[] }> | string {
      if (tokens.length === 0) return 'missing vdev specification'
      const out: Array<{ type: VdevType; names: string[] }> = []
      let cur: { type: VdevType; names: string[] } | null = null
      for (const t of tokens) {
        const kw = t === 'raidz' ? 'raidz1' : t
        if (kw === 'mirror' || kw === 'raidz1' || kw === 'raidz2' || kw === 'raidz3') {
          cur = { type: kw, names: [] }
          out.push(cur)
        } else if (t === 'log' || t === 'cache' || t === 'special' || t === 'spare') {
          return `This chapter only has data vdevs. (${t} vdevs show up later in the game!)`
        } else if (cur) cur.names.push(t.replace(/^\/dev\//, ''))
        else out.push({ type: 'disk', names: [t.replace(/^\/dev\//, '')] })
      }
      return out
    }

    // -------------------------------------------------------- the script
    /** Waits for pool changes until `check` returns true; strings are feedback. */
    async function waitPool(check: () => true | string | null) {
      for (;;) {
        const v = version
        await ctx.until(() => version !== v)
        await ctx.sleep(0.4)
        const r = check()
        if (r === true) return
        if (typeof r === 'string') void ctx.say(r)
      }
    }

    layout()
    renderPanel()
    await ctx.fly(v3(0, 15.5, 19.5), v3(0, 0, 1.0), 2)

    ctx.objectives([
      { id: 'mirror', text: 'Build a 2-disk [[mirror]]' },
      { id: 'pull1', text: 'Pull one disk out of the mirror' },
      { id: 'pull2', text: 'Pull the other disk too' },
      { id: 'cap', text: 'All 8 disks: survive any 2 failures, ≥ 20 TB usable' },
      { id: 'speed', text: 'All 8 disks: survive any 1 failure, ≥ 600 IOPS' },
      { id: 'kill', text: 'Take the fast pool down with as few pulls as possible' },
    ])

    await ctx.next(
      "Welcome to the storage lab! I'm **Ditto**, your guide. I'm named after ZFS's [[ditto|ditto blocks]], the spare copies it keeps of important data. (There are two of me. The other one's shy.)",
    )
    await ctx.next(
      "Those are eight 4 TB hard drives. ZFS doesn't write to disks directly. It groups them into [[vdev|vdevs]] (virtual devices), and one or more vdevs make a [[pool]]. Everything you store lives in the pool.",
    )
    ctx.unlock('pool', 'vdev')

    // Step 1: a mirror
    mode = 'build'
    pickType = 'mirror'
    renderPanel()
    ctx.say(
      'Let\'s build the simplest redundant pool. The type is set to **mirror**. Click **two drives** on the shelf, then press **Add vdev**. Or type `zpool create tank mirror sda sdb` in the terminal.',
    )
    await waitPool(() => {
      if (vdevs.length === 0) return null
      if (vdevs.length === 1 && vdevs[0].type === 'mirror' && vdevs[0].disks.length === 2) return true
      return 'That\'s a valid pool, but for this step I need exactly **one 2-disk mirror**. Press **Destroy pool** and try again.'
    })
    ctx.check('mirror')
    ctx.unlock('mirror')
    mode = 'locked'
    renderPanel()
    await ctx.next(
      'Pool `tank` is **ONLINE**. A [[mirror]] writes every block in full to both disks, so you get 4 TB of usable space out of 8 TB raw, and either disk can serve reads.',
    )

    // Step 2: pull one
    mode = 'pull'
    ctx.say('Disks fail; it\'s what they do. **Click one of the two pool drives** to yank it out of its bay.')
    await waitPool(() => (failed.size >= 1 ? true : null))
    ctx.check('pull1')
    ctx.unlock('states', 'zpool-status')
    mode = 'locked'
    await ctx.next(
      'See the terminal: `zpool status` says the pool is **DEGRADED**. One side is UNAVAIL, but every block still has a good copy on the survivor, so applications keep working. You\'d replace the dead disk and ZFS would [[resilver]] it.',
    )

    // Step 3: pull both
    mode = 'pull'
    ctx.say('Now for the bad day. **Pull the other drive** as well.')
    await waitPool(() => (poolState(vdevs, failed) === 'UNAVAIL' ? true : failed.size === 0 ? 'Pull **both** drives to see what happens.' : null))
    ctx.check('pull2')
    mode = 'locked'
    await ctx.next(
      'With both halves gone the mirror has **insufficient replicas**, the pool is **UNAVAIL**, and I/O stops. A mirror only survives losing n−1 of its n disks. Let me put the drives back on the shelf.',
    )
    destroyPool()
    await ctx.sleep(0.8)

    // Step 4: capacity challenge
    mode = 'build'
    pickType = 'raidz2'
    renderPanel()
    ctx.unlock('raidz')
    ctx.say(
      'Challenge! Use **all 8 drives** to build a pool that survives **any two** disk failures with at least **20 TB** usable. Hint: [[raidz|RAIDZ]] stores parity instead of full copies. RAIDZ2 has two parity disks\' worth per vdev.',
    )
    await waitPool(() => {
      const used = vdevs.reduce((s, v) => s + v.disks.length, 0)
      if (used < 8) return null
      const st = poolStats(vdevs)
      if (st.tolerance >= 2 && st.usableTB >= 20) return true
      const why: string[] = []
      if (st.tolerance < 2) {
        const weak = vdevs.find((v) => vdevTolerance(v) < 2)!
        why.push(
          st.tolerance === 0
            ? 'a single failure on a non-redundant disk would sink it'
            : `two failures inside the same ${weak.type === 'mirror' ? 'mirror' : weak.type} vdev would sink it`,
        )
      }
      if (st.usableTB < 20) why.push(`it only offers ${st.usableTB} TB`)
      return `Close! This layout doesn't qualify: ${why.join(', and ')}. **Destroy pool** and try another layout.`
    })
    ctx.check('cap')
    const winner = vdevs[0]
    await ctx.next(
      winner.type === 'raidz3'
        ? 'RAIDZ3 across 8 disks: 20 TB usable and **three** disks can fail. A very safe pool! RAIDZ2 would also pass with 24 TB.'
        : `RAIDZ2 across 8 disks: **${poolStats(vdevs).usableTB} TB** usable (75% of raw) and any two disks can fail. That's the classic choice for bulk storage.`,
    )
    await ctx.next(
      'The catch: RAIDZ spreads each block across every disk in the vdev, so for small random I/O the whole vdev behaves roughly like **one disk**. See **Random write IOPS** on the left.',
    )
    mode = 'locked'
    destroyPool()
    await ctx.sleep(0.8)

    // Step 5: performance challenge
    mode = 'build'
    pickType = 'mirror'
    renderPanel()
    ctx.say(
      'Now build for speed. Use **all 8 drives**, survive **any single** failure, and reach at least **600** random write IOPS. ZFS stripes writes across all top-level vdevs, so more vdevs means more IOPS.',
    )
    await waitPool(() => {
      const used = vdevs.reduce((s, v) => s + v.disks.length, 0)
      if (used < 8) return null
      const st = poolStats(vdevs)
      if (st.tolerance >= 1 && st.writeIops >= 600) return true
      if (st.tolerance < 1) return 'Fast, but a single disk failure would destroy this pool. Every vdev needs redundancy. **Destroy pool** and try again.'
      return `Safe, but only ${st.vdevCount} vdev${st.vdevCount === 1 ? '' : 's'} (≈ ${st.writeIops} IOPS). You need **4** vdevs. **Destroy pool** and try again.`
    })
    ctx.check('speed')
    ctx.unlock('striping')
    await ctx.next(
      'Four 2-way mirrors: 16 TB usable and ≈ 4× the random IOPS of the RAIDZ2 pool. Resilvers are fast too, since a new disk copies from one partner. Many databases and VM hosts use exactly this layout.',
    )

    // Step 6: kill it
    mode = 'pull'
    ctx.say(
      'Here\'s the catch with striping. Pull disks one at a time and **take this pool down** with as few pulls as you can.',
    )
    await waitPool(() => {
      if (poolState(vdevs, failed) === 'UNAVAIL') return true
      if (failed.size > 0) return `Still **DEGRADED** but online: every mirror still has a working disk. Keep pulling, or click a red drive to plug it back in.`
      return null
    })
    ctx.check('kill')
    mode = 'locked'
    const pulls = failed.size
    await ctx.next(
      pulls === 2
        ? 'Two pulls, same mirror. That vdev is gone, and because every file has blocks on **every** vdev, the whole pool is lost. It survived any one failure, but not two in the wrong place.'
        : `${pulls} pulls, but it can be done in **two**: both halves of the same mirror. Since every file has blocks on every vdev, losing one vdev loses the whole pool.`,
    )
    await ctx.next(
      'So: redundancy lives **inside** vdevs; the pool adds capacity and speed, never safety. Pools can also hold support vdevs: a `log` device for sync writes, `cache` for reads, `special` for metadata, and hot `spare` disks. You\'ll meet some later.',
      'Take the checkpoint',
    )
    ctx.unlock('spare')
    await ctx.finish()
  },
}

