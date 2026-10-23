import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import { Ease, type Scope } from './anim'

/**
 * Colours carry meaning across every chapter. Tree depth runs warm to cool:
 * the uberblock at the root is gold, user data at the leaves is mint.
 */
export const C = {
  uber: '#ffb21e',
  mos: '#ff7a45',
  objset: '#f25f9a',
  dnode: '#a77bff',
  indirect: '#4f9dff',
  data: '#3ee0a1',
  parity: '#c77dff',
  snap: '#8fd8ff',
  zil: '#ffe066',
  corrupt: '#ff3b3b',
  free: '#24324d',
  ghost: '#5b6b8c',
  ok: '#3ee07a',
  warn: '#ffb21e',
  bad: '#ff4d4d',
  steel: '#1a2234',
  steelLight: '#2a3550',
  white: '#e8eefc',
} as const

const shared = <T extends THREE.BufferGeometry>(g: T): T => {
  g.userData.shared = true
  return g
}

export const GEO = {
  block: shared(new RoundedBoxGeometry(1, 1, 1, 3, 0.12)),
  tile: shared(new RoundedBoxGeometry(1, 0.2, 1, 2, 0.06)),
  beam: shared(new THREE.CylinderGeometry(1, 1, 1, 8, 1, true).translate(0, 0.5, 0)),
  sphere: shared(new THREE.SphereGeometry(1, 16, 12)),
  box: shared(new THREE.BoxGeometry(1, 1, 1)),
}

export function blockMaterial(color: string, glow = 0.35) {
  return new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: glow,
    roughness: 0.38,
    metalness: 0.15,
    transparent: true,
    opacity: 1,
  })
}

/** A glowing rounded cube: the basic unit of on-disk structure in the game. */
export class BlockView extends THREE.Group {
  readonly mesh: THREE.Mesh
  readonly mat: THREE.MeshStandardMaterial
  label: CSS2DObject | null = null
  private baseGlow: number
  private hover = false
  private color: string

  constructor(color: string, size = 1, glow = 0.35) {
    super()
    this.color = color
    this.baseGlow = glow
    this.mat = blockMaterial(color, glow)
    this.mesh = new THREE.Mesh(GEO.block, this.mat)
    this.mesh.castShadow = true
    this.mesh.scale.setScalar(size)
    this.add(this.mesh)
  }

  setColor(color: string) {
    this.color = color
    this.mat.color.set(color)
    this.mat.emissive.set(color)
  }

  getColor() {
    return this.color
  }

  setGlow(v: number) {
    this.baseGlow = v
    this.mat.emissiveIntensity = this.hover ? v + 0.6 : v
  }

  setHover(on: boolean) {
    this.hover = on
    this.mat.emissiveIntensity = on ? this.baseGlow + 0.6 : this.baseGlow
  }

  setOpacity(a: number) {
    this.mat.opacity = a
    this.mat.depthWrite = a > 0.95
    this.mesh.castShadow = a > 0.5
    if (this.label) this.label.element.style.opacity = String(Math.max(0, Math.min(1, a)))
  }

  /** Labels go below the block, or to its right with `side`. */
  setLabel(html: string, cls = '', y = 0.85, side = false) {
    if (!this.label) {
      this.label = makeLabel(html, cls)
      this.add(this.label)
    } else {
      this.label.element.innerHTML = html
      this.label.element.className = `lbl ${cls}`
    }
    const s = this.mesh.scale.y
    if (side) {
      this.label.position.set(0.62 * s, 0, 0)
      this.label.center.set(0, 0.5)
      this.label.element.style.margin = '0 0 0 4px'
    } else {
      this.label.position.set(0, -y * s, 0)
      this.label.center.set(0.5, 0)
      this.label.element.style.margin = '2px 0 0 0'
    }
  }

  async flash(scope: Scope, color = '#ffffff', seconds = 0.6) {
    const base = new THREE.Color(this.color)
    const hi = new THREE.Color(color)
    await scope.tween(seconds, (k) => {
      const f = Math.sin(k * Math.PI)
      this.mat.emissive.copy(base).lerp(hi, f)
      this.mat.emissiveIntensity = this.baseGlow + f * 2
    })
    this.mat.emissive.copy(base)
    this.mat.emissiveIntensity = this.baseGlow
  }
}

/**
 * Removes an object from its parent, taking its DOM labels with it.
 * (CSS2DRenderer only cleans up a label when that label itself is removed.)
 */
export function detach(obj: THREE.Object3D) {
  obj.traverse((o) => {
    if (o instanceof CSS2DObject) o.element.remove()
  })
  obj.removeFromParent()
}

export function makeLabel(html: string, cls = '') {
  const div = document.createElement('div')
  div.className = `lbl ${cls}`
  div.innerHTML = html
  const obj = new CSS2DObject(div)
  obj.center.set(0.5, 1)
  return obj
}

const UP = new THREE.Vector3(0, 1, 0)

/** A thin glowing rod between two points; call `set` whenever the ends move. */
export class Beam extends THREE.Mesh {
  readonly mat: THREE.MeshStandardMaterial
  readonly a = new THREE.Vector3()
  readonly b = new THREE.Vector3()

  constructor(color: string, radius = 0.035, glow = 0.8) {
    const mat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: glow,
      transparent: true,
      opacity: 0.9,
      roughness: 0.6,
    })
    super(GEO.beam, mat)
    this.mat = mat
    this.userData.radius = radius
  }

  set(a: THREE.Vector3, b: THREE.Vector3) {
    this.a.copy(a)
    this.b.copy(b)
    const dir = new THREE.Vector3().subVectors(b, a)
    const len = dir.length()
    this.position.copy(a)
    if (len > 1e-6) this.quaternion.setFromUnitVectors(UP, dir.normalize())
    const r = this.userData.radius as number
    this.scale.set(r, Math.max(len, 1e-4), r)
  }

  setColor(color: string) {
    this.mat.color.set(color)
    this.mat.emissive.set(color)
  }
}

/** Sends a bright bead along a path of points. */
export async function pulse(
  scope: Scope,
  parent: THREE.Object3D,
  points: THREE.Vector3[],
  color: string = C.white,
  seconds = 0.6,
  size = 0.14,
) {
  const mat = new THREE.MeshBasicMaterial({ color, transparent: true })
  mat.color.multiplyScalar(3)
  const bead = new THREE.Mesh(GEO.sphere, mat)
  bead.scale.setScalar(size)
  parent.add(bead)
  try {
    const segs = points.length - 1
    for (let i = 0; i < segs; i++) {
      const a = points[i]
      const b = points[i + 1]
      await scope.tween(seconds / segs, (k) => bead.position.lerpVectors(a, b, k), Ease.inOutSine)
    }
  } finally {
    parent.remove(bead)
    mat.dispose()
  }
}

/** A quick expanding spark burst, e.g. for impacts or successful writes. */
export function burst(scope: Scope, parent: THREE.Object3D, at: THREE.Vector3, color: string, count = 26, spread = 1.4) {
  const pos = new Float32Array(count * 3)
  const vel: THREE.Vector3[] = []
  for (let i = 0; i < count; i++) {
    const v = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.9, Math.random() - 0.5).normalize()
    vel.push(v.multiplyScalar(spread * (0.5 + Math.random())))
    pos.set([at.x, at.y, at.z], i * 3)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  const mat = new THREE.PointsMaterial({
    color,
    size: 0.16,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  const pts = new THREE.Points(geo, mat)
  parent.add(pts)
  scope
    .tween(
      0.9,
      (k) => {
        for (let i = 0; i < count; i++) {
          pos[i * 3] = at.x + vel[i].x * k
          pos[i * 3 + 1] = at.y + vel[i].y * k - 0.6 * k * k
          pos[i * 3 + 2] = at.z + vel[i].z * k
        }
        geo.attributes.position.needsUpdate = true
        mat.opacity = 1 - k
      },
      Ease.out,
    )
    .catch(() => {})
    .finally(() => {
      parent.remove(pts)
      geo.dispose()
      mat.dispose()
    })
}

/** A 3.5" hard drive lying flat, with a status LED and a name label. */
export class DriveView extends THREE.Group {
  readonly body: THREE.Mesh
  readonly bodyMat: THREE.MeshStandardMaterial
  readonly led: THREE.Mesh
  readonly ledMat: THREE.MeshBasicMaterial
  readonly label: CSS2DObject
  private ring: THREE.Mesh
  private ringMat: THREE.MeshBasicMaterial
  private state: 'ok' | 'warn' | 'bad' | 'off' = 'ok'

  constructor(
    readonly devName: string,
    sizeText: string,
    kind: 'hdd' | 'ssd' | 'nvme' = 'hdd',
  ) {
    super()
    const dims = kind === 'nvme' ? [0.55, 0.12, 1.6] : kind === 'ssd' ? [1.0, 0.2, 1.4] : [1.2, 0.34, 1.7]
    this.bodyMat = new THREE.MeshStandardMaterial({
      color: kind === 'hdd' ? '#2b3448' : kind === 'ssd' ? '#33304a' : '#1e3a32',
      metalness: 0.75,
      roughness: 0.35,
    })
    const geo = new RoundedBoxGeometry(dims[0], dims[1], dims[2], 2, 0.05)
    this.body = new THREE.Mesh(geo, this.bodyMat)
    this.body.castShadow = true
    this.body.receiveShadow = true
    this.body.position.y = dims[1] / 2
    this.add(this.body)

    // Label plate on top.
    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(dims[0] * 0.78, dims[2] * 0.5),
      new THREE.MeshStandardMaterial({ color: '#c9d3e6', roughness: 0.8, metalness: 0 }),
    )
    plate.rotation.x = -Math.PI / 2
    plate.position.set(0, dims[1] + 0.002, -dims[2] * 0.12)
    this.add(plate)

    this.ledMat = new THREE.MeshBasicMaterial({ color: C.ok })
    this.led = new THREE.Mesh(GEO.sphere, this.ledMat)
    this.led.scale.setScalar(0.045)
    this.led.position.set(dims[0] * 0.36, dims[1] * 0.55, dims[2] / 2 + 0.01)
    this.add(this.led)

    this.ringMat = new THREE.MeshBasicMaterial({ color: C.uber, transparent: true, opacity: 0, depthWrite: false })
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.98, 1.08, 48), this.ringMat)
    this.ring.rotation.x = -Math.PI / 2
    this.ring.position.y = 0.02
    this.ring.scale.setScalar(Math.max(dims[0], dims[2]) * 0.62)
    this.add(this.ring)

    this.label = makeLabel(`<b>${devName}</b><span>${sizeText}</span>`, 'drive')
    this.label.position.set(0, dims[1] + 0.25, 0)
    this.add(this.label)
    this.userData.height = dims[1]
  }

  setState(s: 'ok' | 'warn' | 'bad' | 'off') {
    this.state = s
    this.ledMat.color.set(s === 'ok' ? C.ok : s === 'warn' ? C.warn : s === 'bad' ? C.bad : '#333a48')
    this.ledMat.color.multiplyScalar(s === 'off' ? 1 : 2.2)
    this.bodyMat.emissive.set(s === 'bad' ? '#5a0d0d' : '#000000')
    this.label.element.classList.toggle('bad', s === 'bad')
  }

  getState() {
    return this.state
  }

  setSelected(on: boolean, color: string = C.uber) {
    this.ringMat.color.set(color)
    this.ringMat.opacity = on ? 0.95 : 0
  }

  setHover(on: boolean) {
    this.bodyMat.emissive.set(on ? '#1d2c4d' : this.state === 'bad' ? '#5a0d0d' : '#000000')
  }
}

/** Flat slab with a grid of tile slots, used to show where blocks physically live. */
export class Platter extends THREE.Group {
  readonly tiles: THREE.Mesh[] = []
  readonly tileMats: THREE.MeshStandardMaterial[] = []
  readonly pitch: number

  constructor(
    readonly cols: number,
    readonly rows: number,
    pitch = 0.8,
    title = '',
  ) {
    super()
    this.pitch = pitch
    const w = cols * pitch + 0.5
    const d = rows * pitch + 0.5
    const slab = new THREE.Mesh(
      new RoundedBoxGeometry(w, 0.25, d, 2, 0.08),
      new THREE.MeshStandardMaterial({ color: C.steel, metalness: 0.6, roughness: 0.45 }),
    )
    slab.position.y = 0.125
    slab.receiveShadow = true
    this.add(slab)
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const m = new THREE.MeshStandardMaterial({
          color: C.free,
          emissive: C.free,
          emissiveIntensity: 0.2,
          roughness: 0.5,
          metalness: 0.2,
        })
        const t = new THREE.Mesh(GEO.tile, m)
        t.scale.set(pitch * 0.82, 1, pitch * 0.82)
        t.position.copy(this.localSlot(r * cols + c))
        t.receiveShadow = true
        this.add(t)
        this.tiles.push(t)
        this.tileMats.push(m)
      }
    }
    if (title) {
      // Title sits at the platter's left edge so things in front of it stay readable.
      const lbl = makeLabel(title, 'platter')
      lbl.position.set(-w / 2 - 0.25, 0.2, 0)
      lbl.center.set(1, 0.5)
      this.add(lbl)
    }
  }

  localSlot(i: number) {
    const c = i % this.cols
    const r = Math.floor(i / this.cols)
    return new THREE.Vector3(
      (c - (this.cols - 1) / 2) * this.pitch,
      0.3,
      (r - (this.rows - 1) / 2) * this.pitch,
    )
  }

  worldSlot(i: number) {
    return this.localToWorld(this.localSlot(i))
  }

  setTile(i: number, color: string, glow = 0.45) {
    const m = this.tileMats[i]
    if (!m) return
    m.color.set(color)
    m.emissive.set(color)
    m.emissiveIntensity = glow
  }
}

export const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z)

/** A cosmic ray streaking down from the sky to `at`. */
export async function cosmicRay(scope: Scope, parent: THREE.Object3D, at: THREE.Vector3, color = '#ff6b6b', seconds = 0.35) {
  const from = at.clone().add(new THREE.Vector3((Math.random() - 0.5) * 10, 22, (Math.random() - 0.5) * 6))
  const beam = new Beam(color, 0.05, 3)
  parent.add(beam)
  try {
    await scope.tween(
      seconds,
      (k) => {
        const head = from.clone().lerp(at, k)
        const tail = from.clone().lerp(at, Math.max(0, k - 0.35))
        beam.set(tail, head)
      },
      Ease.in,
    )
    burst(scope, parent, at, color, 22, 1.1)
  } finally {
    parent.remove(beam)
    beam.mat.dispose()
  }
}
