import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import type { ChapterDef, Ctx } from './types'
import { DriveView, C, makeLabel, burst, v3 } from '../engine/kit'
import { h, esc } from '../ui/dom'
import { formatStatus, SEE, type StatusDev } from '../zfs/status'
import { ctime } from '../zfs/units'

type Dev = { name: string; state: string; read: number; write: number; cksum: number; note?: string }

interface Incident {
  id: string
  title: string
  page: string
  hints: string[]
  objective: string
  /** Returns true when the command was handled. Sets `solved` via the closure. */
  handle(argv: string[], line: string): boolean | Promise<boolean>
  solved(): boolean
  outro: string
}

export const chapter9: ChapterDef = {
  id: 'doctor',
  num: 9,
  title: 'Pool Doctor',
  tagline: 'Final exam. You\'re on call: diagnose five real-world incidents and fix them with real commands.',
  tags: ['zpool replace', 'scrub & clear', 'rollback', 'troubleshooting'],
  summary: [
    'Run `zpool status` first: it names the problem and usually suggests an `action:`.',
    'Faulted disk → [[zpool-replace|zpool replace]]. Transient errors → fix the cause, [[scrub]], then [[zpool-clear|zpool clear]].',
    'Snapshots are your undo button, and old snapshots are where space hides.',
    'Slow sync writes → a (mirrored) [[slog|SLOG]], never `sync=disabled`.',
  ],
  quiz: [
    {
      q: 'A disk shows FAULTED with dozens of READ and WRITE errors and SMART says FAILING_NOW. What do you do?',
      options: ['`zpool replace` it with a new disk and let it resilver', '`zpool clear` and keep an eye on it', '`zpool scrub` until the errors go away', 'Take the whole pool offline'],
      answer: 0,
      explain: 'The disk is dying. Replace it while the mirror partner still has every block.',
    },
    {
      q: 'CKSUM errors on one disk, and SMART shows UDMA CRC errors but no reallocated sectors. Most likely cause?',
      options: ['A bad cable or connection', 'The disk platters are failing', 'A ZFS bug', 'The pool is too full'],
      answer: 0,
      explain: 'CRC errors happen on the wire between disk and controller. Reseat or replace the cable, scrub to verify, then clear the counters.',
    },
    {
      q: 'Why avoid running a pool above roughly 80–90% full?',
      options: [
        'Finding free space gets slower and fragmentation rises',
        'ZFS stops verifying checksums',
        'Snapshots are deleted automatically',
        'The ARC stops caching',
      ],
      answer: 0,
      explain: 'Copy-on-write needs free space for every write. Nearly full pools spend more time hunting for space and scatter new blocks.',
    },
    {
      q: 'What does `zpool clear` repair in your data?',
      options: ['Nothing: it resets error counters and returns devices to service', 'Every damaged block in the pool', 'A physically failing disk', 'Permanent errors in files'],
      answer: 0,
      explain: 'Repairs come from redundancy (self-healing and scrubs). Clear resets the counters, puts FAULTED or DEGRADED devices back into service and resumes a suspended pool, so only use it once the cause is fixed.',
    },
  ],

  async run(ctx: Ctx) {
    const { stage, hud, term, sound, scope, root } = ctx
    stage.camera.position.set(0, 13, 24)
    stage.controls.target.set(0, 0.5, 0)

    // ---------------------------------------------------------------- scene
    const rack = new THREE.Mesh(
      new RoundedBoxGeometry(14.5, 0.3, 5.6, 2, 0.08),
      new THREE.MeshStandardMaterial({ color: C.steel, metalness: 0.6, roughness: 0.45 }),
    )
    rack.position.set(0, 0.15, 0)
    rack.receiveShadow = true
    root.add(rack)
    const drives = new Map<string, DriveView>()
    const placeDrive = (name: string, size: string, x: number, z: number, kind: 'hdd' | 'nvme' = 'hdd') => {
      const d = new DriveView(name, size, kind)
      d.position.set(x, 0.3, z)
      root.add(d)
      drives.set(name, d)
      return d
    }
    placeDrive('sda', '8 TB', -5.4, -1.2)
    placeDrive('sdb', '8 TB', -3.8, -1.2)
    placeDrive('sdc', '8 TB', -1.2, -1.2)
    placeDrive('sdd', '8 TB', 0.4, -1.2)
    ;['sdf', 'sdg', 'sdh'].forEach((n, i) => placeDrive(n, '8 TB · new', 2.6 + i * 1.5, 1.5))
    placeDrive('nvme0n1', 'new', -0.6, 1.6, 'nvme')
    placeDrive('nvme1n1', 'new', 0.9, 1.6, 'nvme')
    const lbl = (text: string, x: number, z: number) => {
      const l = makeLabel(text, 'platter')
      l.position.set(x, 0.3, z)
      l.center.set(0.5, 0)
      root.add(l)
      return l
    }
    lbl('mirror-0', -4.6, -3.3)
    lbl('mirror-1', -0.4, -3.3)
    lbl('spare bay (unused)', 3.0, 3.0)

    // ------------------------------------------------------------ pool model
    const devs = new Map<string, Dev>()
    const mk = (name: string): Dev => ({ name, state: 'ONLINE', read: 0, write: 0, cksum: 0 })
    let mirrors: string[][] = [
      ['sda', 'sdb'],
      ['sdc', 'sdd'],
    ]
    for (const n of mirrors.flat()) devs.set(n, mk(n))
    const logs: string[] = []
    let scan = 'none requested'
    let capacity = 61
    const free = new Set(['sdf', 'sdg', 'sdh', 'nvme0n1', 'nvme1n1'])
    let resilvering: string | null = null

    const poolState = () => {
      for (const m of mirrors) {
        const bad = m.filter((n) => ['FAULTED', 'UNAVAIL', 'REMOVED'].includes(devs.get(n)!.state)).length
        if (bad >= m.length) return 'UNAVAIL'
      }
      return [...devs.values()].some((d) => ['FAULTED', 'UNAVAIL', 'REMOVED'].includes(d.state)) || resilvering ? 'DEGRADED' : 'ONLINE'
    }

    function status(verbose = false) {
      const st = poolState()
      const faulted = [...devs.values()].find((d) => d.state === 'FAULTED')
      const errs = [...devs.values()].some((d) => d.cksum || d.read || d.write)
      let status: string | undefined
      let action: string | undefined
      let see: string | undefined
      if (resilvering) {
        status = 'One or more devices is currently being resilvered.  The pool will\ncontinue to function, possibly in a degraded state.'
        action = 'Wait for the resilver to complete.'
      } else if (faulted) {
        status = 'One or more devices are faulted in response to persistent errors.\nSufficient replicas exist for the pool to continue functioning in a\ndegraded state.'
        action = "Replace the faulted device, or use 'zpool clear' to mark the device\nrepaired."
      } else if (errs) {
        status = 'One or more devices has experienced an unrecoverable error.  An\nattempt was made to correct the error.  Applications are unaffected.'
        action = "Determine if the device needs to be replaced, and clear the errors\nusing 'zpool clear' or replace the device with 'zpool replace'."
        see = SEE('ZFS-8000-9P')
      }
      const vd: StatusDev[] = mirrors.map((m, i) => {
        const kids = m.map((n) => {
          const d = devs.get(n)!
          return { name: n, state: d.state, read: d.read, write: d.write, cksum: d.cksum, note: d.note }
        })
        const bad = kids.some((k) => k.state !== 'ONLINE') || (resilvering && m.includes(resilvering))
        return { name: `mirror-${i}`, state: bad ? 'DEGRADED' : 'ONLINE', children: kids }
      })
      return formatStatus({
        pool: 'tank',
        state: st,
        status,
        action,
        see,
        scan,
        vdevs: vd,
        logs: logs.length ? (logs.length === 2 ? [{ name: `mirror-${mirrors.length}`, state: 'ONLINE', children: logs.map((n) => ({ name: n, state: 'ONLINE' })) }] : logs.map((n) => ({ name: n, state: 'ONLINE' }))) : undefined,
        errors: verbose ? 'No known data errors' : undefined,
      })
    }

    function paintDrives() {
      for (const [n, d] of drives) {
        const dev = devs.get(n)
        if (!dev) {
          d.setState(free.has(n) ? 'off' : 'ok')
          continue
        }
        d.setState(dev.state === 'FAULTED' || dev.state === 'UNAVAIL' ? 'bad' : dev.cksum > 0 ? 'warn' : 'ok')
      }
      hud.stats([
        { k: 'tank', v: poolState(), kind: poolState() === 'ONLINE' ? 'ok' : poolState() === 'DEGRADED' ? 'warn' : 'bad' },
        { k: 'cap', v: `${capacity}%`, kind: capacity > 85 ? 'bad' : capacity > 75 ? 'warn' : undefined, narrowHide: true },
      ])
    }

    async function moveDrive(name: string, to: THREE.Vector3) {
      const d = drives.get(name)!
      const from = d.position.clone()
      await ctx.tween(0.8, (k) => {
        d.position.lerpVectors(from, to, k)
        d.position.y += Math.sin(k * Math.PI) * 1.5
      })
    }

    async function resilver(newDev: string, oldDev: string) {
      resilvering = newDev
      const dn = drives.get(newDev)!
      const old = drives.get(oldDev)!
      const slot = old.position.clone()
      old.setState('bad')
      await moveDrive(oldDev, v3(slot.x, 0.3, 3.6))
      await moveDrive(newDev, slot)
      paintDrives()
      for (let i = 0; i < 10; i++) {
        burst(scope, root, dn.position.clone().setY(0.6), C.data, 6, 0.5)
        dn.setSelected(true, C.data)
        await ctx.sleep(0.18)
        dn.setSelected(false)
        await ctx.sleep(0.06)
      }
      resilvering = null
      scan = `resilvered 3.1T in 02:41:07 with 0 errors on ${ctime()}`
      drives.get(oldDev)!.visible = false
      paintDrives()
    }

    // --------------------------------------------------------------- panel
    const ticket = h('div')
    const hintBox = h('div', { class: 'note' })
    let hintIdx = 0
    let current: Incident | null = null
    let hintsUsed = 0
    hud.info(h('div', null, ticket, hintBox))

    const baseSuggestions = ['zpool status', 'zpool list', 'lsblk', 'dmesg']
    let suggestions = [...baseSuggestions]

    function renderTicket(inc: Incident, n: number) {
      hud.expandInfo(true)
      suggestions = [...baseSuggestions]
      term.setSuggestions(suggestions)
      ticket.replaceChildren(
        h('h3', null, `Incident ${n} of ${incidents.length}`),
        h('div', { style: { fontFamily: 'var(--font-display)', fontSize: '17px', fontWeight: '600', margin: '2px 0 6px' } }, inc.title),
        h('div', { class: 'zdb', style: { marginTop: '0', color: '#ffd0d0' }, html: esc(inc.page) }),
      )
      hintIdx = 0
      hintBox.replaceChildren()
      hud.setActions([
        {
          id: 'hint',
          label: 'Hint',
          kind: 'ghost',
          onClick: () => {
            if (!current) return
            if (hintIdx < current.hints.length) {
              hintsUsed++
              const hint = current.hints[hintIdx]
              hintBox.append(h('div', { style: { marginTop: '6px', color: 'var(--fg)' }, html: `<b>Hint ${hintIdx + 1}:</b> ${esc(hint).replace(/`([^`]+)`/g, '<code>$1</code>')}` }))
              // Commands named in hints become tappable suggestions (typing is hard on phones).
              for (const m of hint.matchAll(/`([^`]+)`/g)) if (!suggestions.includes(m[1])) suggestions.push(m[1])
              term.setSuggestions(suggestions)
              hintIdx++
              if (hintIdx === current.hints.length) hud.updateAction('hint', { disabled: true, label: 'No more hints' })
            }
          },
        },
        { id: 'status', label: 'Status', cmd: 'zpool status', onClick: () => void term.run('zpool status') },
      ])
    }

    // ----------------------------------------------------------- incidents
    let i1 = false
    let i2scrub = false
    let i2clear = false
    let i3 = false
    let i4 = false
    let i5 = false
    let syncDisabled = false
    let snapshotsDeleted = false
    let websiteRestored = false

    const projSnaps = ['hourly-1100', 'hourly-1200', 'hourly-1300', 'hourly-1400']

    const common = (argv: string[]): boolean => {
      const [cmd, sub] = argv
      if (cmd === 'zpool' && sub === 'status') {
        term.print(status(argv.includes('-v')))
        return true
      }
      if (cmd === 'zpool' && sub === 'list') {
        term.print(`NAME   SIZE  ALLOC   FREE  CKPOINT  EXPANDSZ   FRAG    CAP  DEDUP    HEALTH  ALTROOT\ntank  14.5T  ${((14.5 * capacity) / 100).toFixed(1)}T  ${((14.5 * (100 - capacity)) / 100).toFixed(1)}T        -         -    ${capacity > 85 ? 41 : 12}%    ${capacity}%  1.00x  ${poolState().padStart(8)}  -`)
        return true
      }
      if (cmd === 'lsblk') {
        term.print(['NAME     SIZE TYPE', ...[...drives.keys()].map((n) => `${n.padEnd(8)} ${n.startsWith('nvme') ? '894.3G' : '7.3T'} disk${free.has(n) ? '   (unused)' : ''}`)].join('\n'))
        return true
      }
      return false
    }

    const incidents: Incident[] = [
      {
        id: 'disk',
        title: 'A disk is failing',
        objective: 'Incident 1: replace the failing disk',
        page: '[PAGER 02:14] tank is DEGRADED on storage-01\n[PAGER 02:14] kernel: I/O error, dev sdb, sector 88123392',
        hints: [
          'Start with `zpool status` to see which device is in trouble, and `smartctl -a /dev/sdb` for its health.',
          'There are brand-new disks in the spare bay: sdf, sdg and sdh.',
          'Swap the bad disk for a new one with `zpool replace tank sdb sdf`.',
        ],
        handle: async (argv) => {
          const [cmd, sub, pool, oldD, newD] = argv
          if (cmd === 'smartctl') {
            const dev = (argv[argv.length - 1] ?? '').replace('/dev/', '')
            term.print(dev === 'sdb' && !i1 ? 'SMART overall-health self-assessment test result: FAILED!\n  5 Reallocated_Sector_Ct   ... 2048   FAILING_NOW\n197 Current_Pending_Sector  ... 312' : `SMART overall-health self-assessment test result: PASSED`)
            return true
          }
          if (cmd === 'dmesg') {
            term.print('[88123.402] blk_update_request: I/O error, dev sdb, sector 88123392 op 0x0:(READ)\n[88123.877] zio pool=tank vdev=/dev/sdb error=5 type=1 offset=45119176704')
            return true
          }
          if (cmd === 'zpool' && sub === 'replace') {
            if (pool !== 'tank') term.print(`cannot open '${pool ?? ''}': no such pool`, 'err')
            else if (oldD !== 'sdb') {
              if (oldD && devs.has(oldD)) term.print(`# ${oldD} is healthy. Which disk is FAULTED?`, 'warn')
              else term.print(`cannot replace ${oldD ?? ''} with ${newD ?? oldD ?? ''}: no such device in pool`, 'err')
            }
            else if (!newD) term.print('cannot replace sdb with sdb: sdb is busy, or device removal is in progress\n# (the disk in the slot is still the broken one: name a new disk from the bay)', 'err')
            else if (newD.startsWith('nvme') && free.has(newD)) term.print(`cannot replace sdb with ${newD}: device is too small`, 'err')
            else if (!free.has(newD)) term.print(devs.has(newD) ? `/dev/${newD} is part of active pool 'tank'` : `cannot open '${newD}': no such device in /dev`, 'err')
            else {
              free.delete(newD)
              devs.delete('sdb')
              mirrors = mirrors.map((m) => m.map((n) => (n === 'sdb' ? newD : n)))
              devs.set(newD, mk(newD))
              await resilver(newD, 'sdb')
              term.print(status())
              i1 = true
            }
            return true
          }
          if (cmd === 'zpool' && sub === 'clear') {
            term.print('# counters cleared, but sdb is still dying: it faults again within minutes.', 'warn')
            return true
          }
          if (cmd === 'zpool' && sub === 'scrub') {
            term.print('# scrubbing a degraded pool on a dying disk adds stress. Replace it first.', 'warn')
            return true
          }
          return false
        },
        solved: () => i1,
        outro: 'Disk replaced and resilvered from its mirror partner. ZFS only copied allocated data, and the pool stayed online the whole time.',
      },
      {
        id: 'cable',
        title: 'Checksum errors on a healthy disk',
        objective: 'Incident 2: deal with the checksum errors',
        page: '[PAGER 09:41] zed: vdev sdc reported 47 checksum errors on tank\n[TICKET] DC tech: "reseated the cable on bay 3 this morning, all good now?"',
        hints: [
          'Check the disk with `smartctl -a /dev/sdc`. Is it the disk, or the path to it?',
          'The tech fixed the cable. Make sure every block is still good with a scrub: `zpool scrub tank`.',
          'Once the scrub comes back clean, reset the counters with `zpool clear tank`.',
        ],
        handle: async (argv) => {
          const [cmd, sub] = argv
          if (cmd === 'smartctl') {
            const dev = (argv[argv.length - 1] ?? '').replace('/dev/', '')
            term.print(dev === 'sdc' ? 'SMART overall-health self-assessment test result: PASSED\n  5 Reallocated_Sector_Ct   ... 0\n199 UDMA_CRC_Error_Count    ... 37' : 'SMART overall-health self-assessment test result: PASSED')
            return true
          }
          if (cmd === 'dmesg') {
            term.print('[3311.120] ata3.00: exception Emask 0x10 SAct 0x0 SErr 0x4050000 action 0xe frozen\n[3311.121] ata3: SError: { PHYRdyChg CommWake DevExch }\n[3311.540] ata3: hard resetting link')
            return true
          }
          if (cmd === 'zpool' && sub === 'replace') {
            term.print('# SMART shows no bad sectors: the errors came from the cable, which is fixed. Replacing a good disk wastes it.', 'warn')
            return true
          }
          if (cmd === 'zpool' && sub === 'scrub') {
            term.print('# scrub started…', 'dim')
            const d = drives.get('sdc')!
            for (let i = 0; i < 6; i++) {
              for (const n of mirrors.flat()) drives.get(n)!.setSelected(true, C.white)
              await ctx.sleep(0.15)
              for (const n of mirrors.flat()) drives.get(n)!.setSelected(false)
              await ctx.sleep(0.08)
            }
            void d
            scan = `scrub repaired 0B in 03:12:44 with 0 errors on ${ctime()}`
            term.print('# scrub finished: 0 errors. The data is fine.', 'ok')
            i2scrub = true
            return true
          }
          if (cmd === 'zpool' && sub === 'clear') {
            if (!i2scrub) term.print('# counters cleared, but you never verified the data. Scrub first, then clear.', 'warn')
            for (const d of devs.values()) d.cksum = 0
            i2clear = i2scrub
            paintDrives()
            return true
          }
          return false
        },
        solved: () => i2scrub && i2clear,
        outro: 'SMART showed CRC errors on the link, not bad sectors. The disk was fine; the cable wasn\'t. A clean scrub proved no data was harmed, and `zpool clear` reset the bookkeeping.',
      },
      {
        id: 'rm',
        title: 'Someone ran rm -rf',
        objective: 'Incident 3: bring back the deleted website',
        page: '[SLACK 14:23] @intern: um. i think i just deleted /tank/projects/website\n[SLACK 14:23] @intern: like, all of it',
        hints: [
          'tank/projects takes hourly snapshots. List them with `zfs list -t snapshot`.',
          'You can roll the whole dataset back to the newest snapshot: `zfs rollback tank/projects@hourly-1400`.',
          'Or copy just the folder back from the hidden snapshot directory: `cp -a /tank/projects/.zfs/snapshot/hourly-1400/website /tank/projects/`.',
        ],
        handle: (argv, line) => {
          const [cmd, sub, target] = argv
          if (cmd === 'zfs' && sub === 'list') {
            if (argv.includes('snapshot')) {
              term.print(['NAME                              USED  AVAIL  REFER  MOUNTPOINT', ...projSnaps.map((s, i) => `tank/projects@${s}`.padEnd(32) + `  ${['1.2M', '840K', '2.4M', '12K'][i].padStart(4)}      -  48.1G  -`)].join('\n'))
            } else term.print(`NAME            USED  AVAIL  REFER  MOUNTPOINT\ntank/projects  48.1G  5.62T  ${websiteRestored ? '48.1G' : '41.7G'}  /tank/projects`)
            return true
          }
          if (cmd === 'ls') {
            if ((target ?? '').includes('.zfs/snapshot/hourly')) term.print('website  api  docs')
            else if ((target ?? '').includes('.zfs/snapshot')) term.print(projSnaps.join('  '))
            else if ((target ?? '').includes('projects')) term.print(websiteRestored ? 'api  docs  website' : 'api  docs')
            else term.print('projects  vm  db')
            return true
          }
          if (cmd === 'zfs' && sub === 'rollback') {
            const [ds, snap] = (argv.filter((a) => !a.startsWith('-'))[2] ?? '').split('@')
            if (ds !== 'tank/projects' || !projSnaps.includes(snap)) term.print(`cannot open '${argv[2] ?? ''}': dataset does not exist`, 'err')
            else if (snap !== 'hourly-1400' && !argv.includes('-r')) term.print(`cannot rollback to 'tank/projects@${snap}': more recent snapshots or bookmarks exist\nuse '-r' to force deletion of the following snapshots and bookmarks:\n${projSnaps.slice(projSnaps.indexOf(snap) + 1).map((s) => `tank/projects@${s}`).join('\n')}`, 'err')
            else {
              if (snap !== 'hourly-1400') term.print('# rolled back further than needed and destroyed newer snapshots, but the website is back.', 'warn')
              websiteRestored = true
              i3 = true
              sound.chime()
            }
            return true
          }
          if (cmd === 'cp' && line.includes('.zfs/snapshot/') && line.includes('website')) {
            websiteRestored = true
            i3 = true
            sound.chime()
            return true
          }
          return false
        },
        solved: () => i3,
        outro: 'Back in seconds. A rollback discards everything after the snapshot; copying from `.zfs/snapshot` restores just the folder and keeps everyone else\'s changes. Both work because snapshots are read-only and always there.',
      },
      {
        id: 'full',
        title: 'The pool is almost full',
        objective: 'Incident 4: get the pool back under 80%',
        page: '[ALERT 11:02] tank capacity 94% (threshold 85%)\n[ALERT 11:02] write latency p99 up 6x since Monday',
        hints: [
          'Space hides in snapshots. Try `zfs list -t snapshot -o name,used -S used` (biggest first).',
          'There\'s a 2.6T snapshot left over from a VM upgrade months ago: `zfs destroy tank/vm@before-upgrade`.',
          'Or add capacity: `zpool add tank mirror sdg sdh` puts two new disks to work as another mirror.',
        ],
        handle: async (argv) => {
          const [cmd, sub] = argv
          if (cmd === 'zfs' && sub === 'list') {
            if (argv.includes('snapshot')) {
              term.print(
                [
                  'NAME                         USED',
                  ...(snapshotsDeleted ? [] : ['tank/vm@before-upgrade       2.61T']),
                  'tank/db@nightly-1021          88G',
                  'tank/db@nightly-1022          61G',
                  'tank/projects@hourly-1400     12K',
                ].join('\n'),
              )
            } else
              term.print(
                ((avail) => `NAME           USED  AVAIL  REFER  MOUNTPOINT\ntank          ${(14.5 * capacity / 100).toFixed(1)}T  ${avail}    96K  /tank\ntank/vm       ${snapshotsDeleted ? '3.61T' : '6.22T'}  ${avail}  3.61T  /tank/vm\ntank/db       2.11T  ${avail}  1.96T  /tank/db\ntank/projects 48.1G  ${avail}  48.1G  /tank/projects`)(`${(14.5 * (100 - capacity) / 100).toFixed(1)}T`),
              )
            return true
          }
          if (cmd === 'zfs' && sub === 'destroy') {
            const t = argv[argv.length - 1]
            if (t === 'tank/vm@before-upgrade') {
              snapshotsDeleted = true
              capacity = 76
              paintDrives()
              term.print('# destroyed tank/vm@before-upgrade: 2.61T freed', 'ok')
              i4 = true
            } else if (t?.includes('@')) term.print(`# that snapshot is small; it won't free much. Look for the big one.`, 'warn')
            else term.print(`Destroying a whole dataset? Ditto grabs your wrist. Let's only delete snapshots today.`, 'warn')
            return true
          }
          if (cmd === 'zpool' && sub === 'add') {
            const rest = argv.slice(3)
            if (rest[0] === 'mirror' && rest.length === 3 && rest.slice(1).every((n) => free.has(n) && !n.startsWith('nvme'))) {
              for (const n of rest.slice(1)) free.delete(n)
              mirrors = [...mirrors, rest.slice(1)]
              for (const n of rest.slice(1)) devs.set(n, mk(n))
              await Promise.all(rest.slice(1).map((n, k) => moveDrive(n, v3(2.4 + k * 1.6, 0.3, -1.2))))
              lbl(`mirror-${mirrors.length - 1}`, 3.2, -3.3)
              capacity = 63
              paintDrives()
              term.print('# new vdev added: capacity jumps, and new writes favour the empty mirror', 'ok')
              i4 = true
            } else if (rest[0] !== 'mirror' && rest.length >= 1 && !['log', 'cache', 'spare'].includes(rest[0])) {
              term.print(`invalid vdev specification\nuse '-f' to override the following errors:\nmismatched replication level: pool uses mirror and new vdev is disk`, 'err')
            } else return false
            return true
          }
          return false
        },
        solved: () => i4,
        outro: 'Nearly full pools get slow: copy-on-write needs free space for every write, and the allocator works harder as space fragments. Keep pools under about 80%, and watch for forgotten snapshots.',
      },
      {
        id: 'slow',
        title: 'The database is slow',
        objective: 'Incident 5: make database commits fast, safely',
        page: '[TICKET] app team: "every commit takes 9-10 ms, p99 is awful"\n[TICKET] app team: "a blog post says set sync=disabled, can we?"',
        hints: [
          'Commits are fsync() calls: sync writes that go through the ZIL, which currently lives on spinning disks.',
          'Give the ZIL a fast device. Two NVMe drives are sitting in the bay.',
          'Add a mirrored SLOG: `zpool add tank log mirror nvme0n1 nvme1n1`.',
        ],
        handle: async (argv) => {
          const [cmd, sub] = argv
          if (cmd === 'zfs' && sub === 'set') {
            const v = (argv[2] ?? '').replace('sync=', '')
            if (v === 'disabled') {
              syncDisabled = true
              term.print('# commits are instant now… because they\'re no longer durable. A crash will lose acknowledged transactions.', 'err')
              void ctx.say('Whoa! That makes commits fast by **lying** about durability. Set it back with `zfs set sync=standard tank/db`, then fix it properly.')
            } else if (v === 'standard') {
              syncDisabled = false
              term.print('# sync=standard restored', 'ok')
            } else term.print(`cannot set property: ${argv[2] ?? ''}`, 'err')
            return true
          }
          if (cmd === 'zfs' && sub === 'get') {
            term.print(`NAME     PROPERTY  VALUE     SOURCE\ntank/db  sync      ${syncDisabled ? 'disabled  local' : 'standard  default'}`)
            return true
          }
          if (cmd === 'zpool' && sub === 'add' && argv[3] === 'log') {
            const parts = argv.slice(4)
            const names = parts[0] === 'mirror' ? parts.slice(1) : parts
            if (!names.length || !names.every((n) => n.startsWith('nvme') && free.has(n))) {
              term.print(`cannot open '${names.find((n) => !free.has(n)) ?? ''}': no such device in /dev`, 'err')
              return true
            }
            for (const n of names) free.delete(n)
            logs.push(...names)
            await Promise.all(names.map((n, k) => moveDrive(n, v3(5.5 + k * 0.9, 0.3, -1.3))))
            lbl('logs', 6, -3.3)
            term.print(names.length === 1 ? '# single SLOG added. Works, but a mirrored SLOG avoids losing in-flight commits if it dies during a crash.' : '# mirrored SLOG added', 'ok')
            i5 = true
            return true
          }
          if (cmd === 'zpool' && sub === 'add' && argv[3] === 'cache') {
            term.print('# an L2ARC speeds up reads. These are slow writes (commits): a different problem.', 'warn')
            return true
          }
          return false
        },
        solved: () => i5 && !syncDisabled,
        outro: 'Commits now wait for NVMe, not spinning disks, and they are still durable. The mirror means a dead SLOG at the worst possible moment can\'t take acknowledged transactions with it.',
      },
    ]

    term.setHandler(
      async (argv, line) => {
        if (common(argv)) return true
        if (current) return await current.handle(argv, line)
        return false
      },
      [
        'You\'re root on storage-01. Useful commands:',
        '  zpool status [-v] | zpool list | lsblk | dmesg',
        '  smartctl -a /dev/<disk>',
        '  zpool replace | scrub | clear | add',
        '  zfs list [-t snapshot] | rollback | destroy | get | set',
        'Stuck? Press Hint.',
      ].join('\n'),
    )
    term.setSuggestions(baseSuggestions)

    // -------------------------------------------------------------- script
    paintDrives()
    term.toggle(true)
    await ctx.fly(v3(0.5, 10, 14), v3(0.5, 0.4, 0.4), 2)
    ctx.objectives(incidents.map((inc) => ({ id: inc.id, text: inc.objective })))
    ctx.unlock('zpool-status', 'zpool-replace', 'zpool-clear', 'states')

    await ctx.next(
      'Final exam! You\'re on call for `storage-01`: pool `tank`, two mirrors of 8 TB disks, plus a bay of spare hardware. Pages will come in. Diagnose them in the **terminal** with real commands. **Hint** helps if you\'re stuck, but try `zpool status` first.',
      'Bring it on',
    )

    for (let n = 0; n < incidents.length; n++) {
      const inc = incidents[n]
      current = inc
      // Incident setup.
      if (inc.id === 'disk') {
        const d = devs.get('sdb')!
        d.state = 'FAULTED'
        d.read = 23
        d.write = 41
        d.note = 'too many errors'
      } else if (inc.id === 'cable') {
        devs.get('sdc')!.cksum = 47
        scan = 'none requested'
      } else if (inc.id === 'full') {
        capacity = 94
      }
      paintDrives()
      renderTicket(inc, n + 1)
      sound.bad()
      ctx.say(`**New page.** ${inc.title}. Read the ticket in the panel, then investigate.`)
      await ctx.until(() => inc.solved())
      await ctx.sleep(0.4)
      ctx.check(inc.id)
      hud.setActions([])
      await ctx.next(inc.outro, n < incidents.length - 1 ? 'Next page' : 'Finish shift')
    }
    current = null
    await ctx.next(
      `Shift over: five incidents, ${hintsUsed === 0 ? 'no hints needed. Impressive!' : `${hintsUsed} hint${hintsUsed === 1 ? '' : 's'} used.`} You've built pools, followed checksums, survived crashes, healed bit rot, rebuilt RAIDZ by hand, rolled back ransomware, tamed the ZIL and the ARC. You know how ZFS works on the inside.`,
      'Take the final checkpoint',
    )
    await ctx.finish()
  },
}
