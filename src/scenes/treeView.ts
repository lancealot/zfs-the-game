import * as THREE from 'three'
import type { Stage } from '../engine/stage'
import type { Scope } from '../engine/anim'
import { BlockView, Beam, Platter, C, GEO, makeLabel, pulse, burst, detach, v3 } from '../engine/kit'
import { type CowPool, type Blk, type SyncPlan, RING } from '../zfs/blocktree'
import { cksumShort } from '../zfs/checksum'

export const KIND_COLOR: Record<Blk['kind'], string> = {
  mos: C.mos,
  objset: C.objset,
  dnode: C.dnode,
  indirect: C.indirect,
  data: C.data,
}

const Y = { uber: 10.8, mos: 9.35, objset: 7.9, dnode: 6.45, indirect: 5.0, data: 3.55 }
const Z_STEP = 1.9
const Z_INFLIGHT = 2.6

type LabelMode = 'name' | 'birth' | 'cksum' | 'none'
type Status = 'live' | 'inflight' | 'held'

interface Node {
  blk: Blk
  view: BlockView
  target: THREE.Vector3
  status: Status
  unpick: () => void
  dying: boolean
}

export interface TreeViewOptions {
  dataset: string
  cols: number
  rows: number
  spacing?: number
  platterZ?: number
  showRing?: boolean
}

/**
 * Renders a CowPool: the logical block tree floating above, the physical
 * disk (a platter of slots) below, and the uberblock on top. Nodes glide
 * toward target positions, so callers mostly just change state and call
 * `refresh()`.
 */
export class TreeView {
  readonly group = new THREE.Group()
  readonly platter: Platter
  readonly uberView: BlockView
  onPick: ((b: Blk) => void) | null = null
  onPickUber: (() => void) | null = null
  labelMode: LabelMode = 'name'
  /** Extra text appended to a block's label, e.g. a snapshot name. */
  tags = new Map<Blk, string>()
  /** Blocks drawn as damaged. */
  corrupt = new Set<Blk>()
  /** Blocks that exist in the pool but aren't drawn yet (written later in an animation). */
  hidden = new Set<Blk>()
  readonly dataset: string

  private nodes = new Map<Blk, Node>()
  private beams = new Map<string, Beam>()
  private columns = new Map<string, number>()
  private colCount = 0
  private plan: SyncPlan | null = null
  private uberBeam: Beam
  private dropLine: Beam
  private ringTiles: THREE.Mesh[] = []
  private ringLabels: Array<ReturnType<typeof makeLabel>> = []
  private hoverBlk: Blk | null = null
  private hinted: Blk | null = null
  private time = 0
  private spacing: number
  private uberTarget = new THREE.Vector3()

  constructor(
    private stage: Stage,
    private scope: Scope,
    readonly pool: CowPool,
    opts: TreeViewOptions,
  ) {
    this.dataset = opts.dataset
    this.spacing = opts.spacing ?? 1.35
    stage.world.add(this.group)

    this.platter = new Platter(opts.cols, opts.rows, 0.78, 'vdev 0 · physical blocks')
    this.platter.position.set(0, 0, opts.platterZ ?? 4.2)
    this.group.add(this.platter)

    this.uberView = new BlockView(C.uber, 0.95, 0.45)
    this.uberView.position.set(0, Y.uber, 0)
    this.uberTarget.set(0, Y.uber, 0)
    this.group.add(this.uberView)
    stage.pick(this.uberView, {
      onHover: (on) => this.uberView.setHover(on),
      onClick: () => this.onPickUber?.(),
      tooltip: () => `uberblock · txg ${this.pool.uber.txg} · click to inspect`,
    })
    this.uberBeam = new Beam(C.uber, 0.04, 1.1)
    this.group.add(this.uberBeam)

    this.dropLine = new Beam(C.white, 0.018, 1.4)
    this.dropLine.visible = false
    this.group.add(this.dropLine)

    if (opts.showRing) this.buildRing()

    scope.onUpdate((dt) => this.tick(dt))
    this.refresh(false)
  }

  // ------------------------------------------------------------- public

  setPlan(plan: SyncPlan | null) {
    this.plan = plan
  }

  view(b: Blk): BlockView | undefined {
    return this.nodes.get(b)?.view
  }

  pos(b: Blk): THREE.Vector3 {
    const n = this.nodes.get(b)
    return n ? n.view.position.clone() : this.slotPos(b.slot)
  }

  targetOf(b: Blk) {
    return this.nodes.get(b)?.target.clone()
  }

  uberPos() {
    return this.uberView.position.clone()
  }

  slotPos(slot: number) {
    return this.platter.position.clone().add(this.platter.localSlot(slot))
  }

  /** Centre of the tree, for camera framing. */
  center() {
    return v3(0, (Y.uber + this.platter.position.y) / 2 + 0.5, 1.2)
  }

  width() {
    return Math.max(this.colCount * this.spacing, this.platter.cols * this.platter.pitch)
  }

  /**
   * Reconciles views with the pool. New blocks appear at their target
   * (or, with `rise`, climb out of their disk slot); vanished blocks sink
   * back into the platter and fade.
   */
  refresh(animate = true, rise = false) {
    const shown = new Set(this.pool.slots.filter((b): b is Blk => !!b && !this.hidden.has(b)))
    const status = this.statuses(shown)
    const targets = this.layout(shown, status)

    for (const b of shown) {
      let n = this.nodes.get(b)
      if (!n) {
        n = this.makeNode(b)
        const t = targets.get(b)!
        if (animate && rise) {
          n.view.position.copy(this.slotPos(b.slot))
          n.view.scale.setScalar(0.3)
        } else n.view.position.copy(t)
      }
      n.status = status.get(b)!
      n.target.copy(targets.get(b)!)
      n.dying = false
    }
    for (const [b, n] of this.nodes) {
      if (shown.has(b) || n.dying) continue
      if (animate) this.kill(n)
      else this.removeNode(n)
    }
    this.restyle()
    this.syncBeams()
    this.paintPlatter()
    this.updateRing()
    this.uberView.setLabel(`uberblock · txg ${this.pool.uber.txg}`, 'amber', 0.62, true)
  }

  /** Writes one in-flight block: the slot lights up, then the node climbs into the tree. */
  async rise(b: Blk, seconds = 0.55) {
    this.hidden.delete(b)
    const tile = this.platter.tileMats[b.slot]
    this.platter.setTile(b.slot, KIND_COLOR[b.kind], 1.4)
    burst(this.scope, this.group, this.slotPos(b.slot).setY(0.5), KIND_COLOR[b.kind], 12, 0.8)
    this.refresh(true, true)
    await this.scope.sleep(seconds)
    if (tile) tile.emissiveIntensity = 0.6
  }

  /** Sends a bead from the uberblock down a path of blocks. */
  async trace(path: Blk[], color: string = C.white, seconds = 1.2) {
    const pts = [this.uberView.position.clone(), ...path.map((b) => this.pos(b))]
    await pulse(this.scope, this.group, pts, color, seconds, 0.12)
  }

  flash(b: Blk, color: string = C.white) {
    const n = this.nodes.get(b)
    if (n) void n.view.flash(this.scope, color, 0.7).catch(() => {})
  }

  flashUber() {
    void this.uberView.flash(this.scope, C.white, 0.9).catch(() => {})
  }

  highlight(blks: Iterable<Blk>, color: string | null) {
    const set = new Set(blks)
    for (const [b, n] of this.nodes) {
      if (set.has(b) && color) {
        n.view.setColor(color)
        n.view.setGlow(1.1)
      }
    }
    if (!color) this.restyle()
  }

  /** Makes one block pulse to show the player where to click next. */
  hint(b: Blk | null) {
    const prev = this.hinted
    this.hinted = b
    if (prev) {
      const n = this.nodes.get(prev)
      if (n) this.styleNode(n)
    }
  }

  /** Marks or clears a slot as visibly damaged on the platter only. */
  markSlot(slot: number, color: string | null) {
    if (color) this.platter.setTile(slot, color, 1.3)
    else this.paintPlatter()
  }

  setLabels(mode: LabelMode) {
    this.labelMode = mode
    this.restyle()
  }

  restyle() {
    for (const n of this.nodes.values()) this.styleNode(n)
  }

  /** Shows the uberblock moving its pointer to a new MOS. */
  async commit() {
    this.flashUber()
    this.updateRing(true)
    burst(this.scope, this.group, this.uberView.position.clone(), C.uber, 30, 1.6)
    await this.scope.sleep(0.6)
  }

  // ----------------------------------------------------------- internals

  private statuses(shown: Set<Blk>): Map<Blk, Status> {
    const inflight = new Set(this.plan?.written ?? [])
    const live = this.pool.reachable([...this.pool.datasets.values()])
    live.add(this.pool.uber.root)
    const out = new Map<Blk, Status>()
    for (const b of shown) out.set(b, inflight.has(b) ? 'inflight' : live.has(b) ? 'live' : 'held')
    return out
  }

  private key(b: Blk) {
    const m = b.meta
    switch (b.kind) {
      case 'data':
        return `d|${m.dataset}|${m.file}|${m.index}`
      case 'indirect':
        return `i|${m.dataset}|${m.file}`
      case 'dnode':
        return `n|${m.dataset}`
      case 'objset':
        return `o|${m.dataset}`
      default:
        return 'mos'
    }
  }

  private ensureColumns(shown: Set<Blk>) {
    // Columns follow the live file order first, then anything only snapshots still have.
    const order: Blk[] = []
    const live = this.pool.datasets.get(this.dataset)
    if (live) for (const fr of live.children[0].children) order.push(fr)
    for (const b of shown) if ((b.kind === 'data' && b.meta.index === 0) || b.kind === 'indirect') order.push(b)
    for (const fr of order) {
      const f = fr.meta.file!
      if (this.columns.has(f)) continue
      const n = fr.kind === 'data' ? 1 : fr.children.length
      this.columns.set(f, this.colCount)
      this.colCount += n
    }
  }

  private layout(shown: Set<Blk>, status: Map<Blk, Status>): Map<Blk, THREE.Vector3> {
    this.ensureColumns(shown)
    const xOf = (col: number) => (col - (this.colCount - 1) / 2) * this.spacing
    // Blocks owned by another dataset (a clone) are drawn off to the right.
    const side = (this.colCount * this.spacing) / 2 + 2.6
    const base = (b: Blk): THREE.Vector3 => {
      const p = baseInTree(b)
      if (b.meta.dataset && b.meta.dataset !== this.dataset) p.x += side
      return p
    }
    const baseInTree = (b: Blk): THREE.Vector3 => {
      const m = b.meta
      switch (b.kind) {
        case 'data': {
          const c = this.columns.get(m.file!) ?? 0
          return v3(xOf(c + (m.index ?? 0)), Y.data, 0)
        }
        case 'indirect': {
          const c = this.columns.get(m.file!) ?? 0
          const n = b.children.length
          return v3((xOf(c) + xOf(c + n - 1)) / 2, Y.indirect, 0)
        }
        case 'dnode':
          return v3(0, Y.dnode, 0)
        case 'objset':
          return v3(0, Y.objset, 0)
        default:
          return v3(0, Y.mos, 0)
      }
    }
    const groups = new Map<string, Blk[]>()
    for (const b of shown) {
      const k = this.key(b)
      const g = groups.get(k)
      if (g) g.push(b)
      else groups.set(k, [b])
    }
    const out = new Map<Blk, THREE.Vector3>()
    for (const g of groups.values()) {
      const held = g.filter((b) => status.get(b) === 'held').sort((a, b) => b.id - a.id)
      for (const b of g) {
        const p = base(b)
        const s = status.get(b)
        if (s === 'inflight') p.z = Z_INFLIGHT
        else if (s === 'held') {
          const depth = held.indexOf(b) + 1
          p.z = -Z_STEP * 1.15 * depth
          p.y += 0.35 * depth
        }
        out.set(b, p)
      }
    }
    return out
  }

  private makeNode(b: Blk): Node {
    const size = b.kind === 'data' ? 0.72 : b.kind === 'mos' ? 0.9 : 0.8
    const view = new BlockView(KIND_COLOR[b.kind], size, 0.4)
    this.group.add(view)
    const n: Node = { blk: b, view, target: new THREE.Vector3(), status: 'live', unpick: () => {}, dying: false }
    n.unpick = this.stage.pick(view, {
      onHover: (on) => {
        view.setHover(on)
        this.hoverBlk = on ? b : this.hoverBlk === b ? null : this.hoverBlk
      },
      onClick: () => this.onPick?.(b),
      tooltip: () => this.tooltip(b),
    })
    this.nodes.set(b, n)
    return n
  }

  private tooltip(b: Blk) {
    const n = this.nodes.get(b)
    const where = n?.status === 'held' ? ' · held by a snapshot' : n?.status === 'inflight' ? ' · written, not yet committed' : ''
    const what =
      b.kind === 'data'
        ? `L0 data · ${b.meta.file}${b.meta.index !== undefined ? ` block ${b.meta.index}` : ''}`
        : b.kind === 'indirect'
          ? `L1 indirect · ${b.meta.file}`
          : b.kind === 'dnode'
            ? `dnode block · ${b.meta.dataset}`
            : b.kind === 'objset'
              ? `object set · ${b.meta.dataset}`
              : 'MOS · meta object set'
    return `${what} · birth txg ${b.birth}${where}`
  }

  private styleNode(n: Node) {
    const b = n.blk
    const v = n.view
    if (this.corrupt.has(b)) {
      v.setColor(C.corrupt)
      v.setGlow(1.2)
    } else {
      v.setColor(KIND_COLOR[b.kind])
      v.setGlow(n.status === 'inflight' ? 0.9 : n.status === 'held' ? 0.15 : 0.4)
    }
    if (!n.dying) v.setOpacity(n.status === 'held' ? 0.5 : 1)
    const tag = this.tags.get(b)
    let text = ''
    if (this.labelMode === 'name') {
      text =
        b.kind === 'data'
          ? b.meta.index === 0 && this.isSingle(b)
            ? b.meta.file!
            : String(b.meta.index)
          : b.kind === 'indirect'
            ? `L1 · ${b.meta.file}`
            : b.kind === 'dnode'
              ? 'dnodes'
              : b.kind === 'objset'
                ? b.meta.dataset!
                : 'MOS'
    } else if (this.labelMode === 'birth') text = b.kind === 'data' ? String(b.birth) : `txg ${b.birth}`
    else if (this.labelMode === 'cksum') text = cksumShort(b.cksum)
    // Faded snapshot-only blocks keep quiet unless they carry a tag like a snapshot name.
    if (n.status === 'held') text = tag ?? ''
    else if (tag) text = text ? `${text} ${tag}` : tag
    const cls = n.status === 'held' ? 'violet faint' : n.status === 'inflight' ? 'amber' : this.corrupt.has(b) ? 'bad' : ''
    // A block about to be replaced by an in-flight copy steps back so the new one reads clearly.
    const superseded = n.status === 'live' && !!this.plan?.replaced.has(b) && !this.hidden.has(this.plan.replaced.get(b)!)
    if (superseded && !this.corrupt.has(b)) v.setGlow(0.12)
    if (text) v.setLabel(text, cls, 0.62, b.kind !== 'data')
    if (v.label) v.label.visible = !!text && !superseded
  }

  private isSingle(b: Blk) {
    // A single-block file hangs straight off the dnode block.
    for (const n of this.nodes.values()) if (n.blk.kind === 'dnode' && n.blk.children.includes(b)) return true
    return false
  }

  private kill(n: Node) {
    n.dying = true
    n.unpick()
    n.target.copy(this.slotPos(n.blk.slot))
    const start = n.view.mat.opacity
    this.scope
      .tween(0.9, (k) => {
        n.view.setOpacity(start * (1 - k))
        n.view.scale.setScalar(1 - 0.6 * k)
      })
      .catch(() => {})
      .finally(() => this.removeNode(n))
  }

  private removeNode(n: Node) {
    if (this.nodes.get(n.blk) !== n) return
    n.unpick()
    detach(n.view)
    n.view.mat.dispose()
    this.nodes.delete(n.blk)
    if (this.hoverBlk === n.blk) this.hoverBlk = null
  }

  private syncBeams() {
    const want = new Set<string>()
    for (const n of this.nodes.values()) {
      if (n.dying) continue
      for (const c of n.blk.children) {
        const cn = this.nodes.get(c)
        if (!cn || cn.dying) continue
        const k = `${n.blk.id}>${c.id}`
        want.add(k)
        let beam = this.beams.get(k)
        if (!beam) {
          beam = new Beam(C.ghost, 0.026, 0.7)
          beam.userData.from = n
          beam.userData.to = cn
          this.group.add(beam)
          this.beams.set(k, beam)
        }
        const held = n.status === 'held'
        const inflight = n.status === 'inflight'
        beam.setColor(inflight ? C.uber : held ? C.dnode : '#7d8fb8')
        beam.mat.opacity = held ? 0.35 : 0.85
        beam.mat.emissiveIntensity = inflight ? 1.2 : held ? 0.3 : 0.6
      }
    }
    for (const [k, beam] of this.beams) {
      if (want.has(k)) continue
      this.group.remove(beam)
      beam.mat.dispose()
      this.beams.delete(k)
    }
  }

  private paintPlatter() {
    for (let i = 0; i < this.pool.slots.length; i++) {
      const b = this.pool.slots[i]
      if (!b || this.hidden.has(b)) {
        this.platter.setTile(i, C.free, 0.2)
        continue
      }
      const n = this.nodes.get(b)
      const color = this.corrupt.has(b) ? C.corrupt : KIND_COLOR[b.kind]
      this.platter.setTile(i, color, n?.status === 'held' ? 0.12 : n?.status === 'inflight' ? 0.9 : 0.45)
      if (n?.status === 'held') this.platter.tileMats[i].color.multiplyScalar(0.45)
    }
  }

  private buildRing() {
    const z = this.platter.position.z + (this.platter.rows * this.platter.pitch) / 2 + 1.1
    const lbl = makeLabel('uberblock ring (vdev label)', 'platter')
    lbl.position.set(-((RING - 1) / 2) * 0.85 - 0.6, 0.2, z)
    lbl.center.set(1, 0.5)
    this.group.add(lbl)
    for (let i = 0; i < RING; i++) {
      const m = new THREE.MeshStandardMaterial({ color: C.free, emissive: C.free, emissiveIntensity: 0.3, roughness: 0.5 })
      const t = new THREE.Mesh(GEO.tile, m)
      t.scale.set(0.7, 1, 0.5)
      t.position.set((i - (RING - 1) / 2) * 0.85, 0.12, z)
      this.group.add(t)
      this.ringTiles.push(t)
      const l = makeLabel('', 'faint')
      l.position.set(t.position.x, 0.35, z)
      l.center.set(0.5, 1)
      this.group.add(l)
      this.ringLabels.push(l)
    }
  }

  private updateRing(flashNew = false) {
    if (!this.ringTiles.length) return
    const cur = this.pool.uber.txg
    for (let i = 0; i < RING; i++) {
      const u = this.pool.ring[i]
      const m = this.ringTiles[i].material as THREE.MeshStandardMaterial
      const color = !u ? C.free : !u.valid ? C.corrupt : u.txg === cur ? C.uber : '#8a6a2a'
      m.color.set(color)
      m.emissive.set(color)
      m.emissiveIntensity = u && u.txg === cur ? (flashNew ? 2 : 0.9) : 0.3
      this.ringLabels[i].element.textContent = u ? String(u.txg) : ''
      this.ringLabels[i].element.className = `lbl ${u && u.txg === cur ? 'amber' : u && !u.valid ? 'bad' : 'faint'}`
    }
  }

  ringPos(txg: number) {
    const t = this.ringTiles[txg % RING]
    return t ? t.position.clone() : this.uberView.position.clone()
  }

  private tick(dt: number) {
    this.time += dt
    const k = 1 - Math.exp(-dt * 6)
    if (this.hinted) {
      const n = this.nodes.get(this.hinted)
      if (n) n.view.setGlow(0.5 + 0.9 * (0.5 + 0.5 * Math.sin(this.time * 7)))
    }
    for (const n of this.nodes.values()) {
      n.view.position.lerp(n.target, k)
      if (!n.dying && n.view.scale.x < 0.999) n.view.scale.setScalar(n.view.scale.x + (1 - n.view.scale.x) * k)
    }
    this.uberView.position.lerp(this.uberTarget, k)
    for (const beam of this.beams.values()) {
      const a = (beam.userData.from as Node).view.position
      const b = (beam.userData.to as Node).view.position
      beam.set(a, b)
    }
    const root = this.nodes.get(this.pool.uber.root)
    if (root) {
      this.uberBeam.visible = true
      this.uberBeam.set(this.uberView.position, root.view.position)
    } else this.uberBeam.visible = false
    if (this.hoverBlk && this.nodes.get(this.hoverBlk)) {
      this.dropLine.visible = true
      this.dropLine.set(this.nodes.get(this.hoverBlk)!.view.position, this.slotPos(this.hoverBlk.slot))
    } else this.dropLine.visible = false
  }
}
