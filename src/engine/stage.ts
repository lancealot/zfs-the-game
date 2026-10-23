import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { Animator, Ease, type Ticker } from './anim'

export interface PickHandlers {
  onClick?: (hit: THREE.Intersection) => void
  onHover?: (on: boolean) => void
  tooltip?: string | (() => string)
}

export type Quality = 'high' | 'low'

export interface Insets {
  top: number
  bottom: number
  left: number
  right: number
}

const BG = new THREE.Color('#070c18')

/**
 * Owns the WebGL renderer, camera, controls and the render loop. Chapter
 * content goes into `world`, which is emptied between chapters.
 */
export class Stage implements Ticker {
  readonly renderer: THREE.WebGLRenderer
  readonly labels: CSS2DRenderer
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  readonly controls: OrbitControls
  readonly world = new THREE.Group()
  readonly anim = new Animator()
  /** Multiplies the speed of all game-time animation. */
  timeScale = 1
  paused = false

  private composer: EffectComposer | null = null
  private keyLight: THREE.DirectionalLight
  private shadowFloor: THREE.Mesh
  private updaters = new Set<(dt: number, t: number) => void>()
  private picks = new Map<THREE.Object3D, PickHandlers>()
  private raycaster = new THREE.Raycaster()
  private ndc = new THREE.Vector2()
  private hovered: THREE.Object3D | null = null
  private down: { x: number; y: number; t: number } | null = null
  private timer = new THREE.Timer()
  private elapsed = 0
  private size = { w: 1, h: 1 }
  private insets: Insets = { top: 0, bottom: 0, left: 0, right: 0 }
  private flight = 0
  private quality: Quality = 'high'

  constructor(
    private container: HTMLElement,
    private tooltip: HTMLElement,
  ) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.05
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFShadowMap
    renderer.domElement.className = 'gl'
    container.appendChild(renderer.domElement)
    this.renderer = renderer

    const labels = new CSS2DRenderer()
    labels.domElement.className = 'labels'
    container.appendChild(labels.domElement)
    this.labels = labels

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 400)
    this.camera.position.set(14, 11, 18)

    const controls = new OrbitControls(this.camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.minDistance = 4
    controls.maxDistance = 70
    controls.maxPolarAngle = Math.PI * 0.47
    controls.screenSpacePanning = true
    controls.target.set(0, 2, 0)
    controls.autoRotateSpeed = 0.4
    this.controls = controls

    const scene = this.scene
    scene.background = BG
    scene.fog = new THREE.Fog(BG, 40, 110)
    const pmrem = new THREE.PMREMGenerator(renderer)
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environmentIntensity = 0.35
    pmrem.dispose()

    scene.add(new THREE.HemisphereLight('#9fb8ff', '#0b1020', 0.7))
    const key = new THREE.DirectionalLight('#fff3e0', 1.8)
    key.position.set(10, 22, 12)
    key.castShadow = true
    key.shadow.mapSize.set(2048, 2048)
    key.shadow.camera.left = -30
    key.shadow.camera.right = 30
    key.shadow.camera.top = 30
    key.shadow.camera.bottom = -30
    key.shadow.camera.far = 80
    key.shadow.bias = -0.0005
    key.shadow.normalBias = 0.02
    scene.add(key)
    this.keyLight = key
    const rim = new THREE.DirectionalLight('#6fa8ff', 0.6)
    rim.position.set(-14, 8, -16)
    scene.add(rim)

    scene.add(makeGridFloor())
    this.shadowFloor = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.ShadowMaterial({ color: '#000000', opacity: 0.35 }),
    )
    this.shadowFloor.rotation.x = -Math.PI / 2
    this.shadowFloor.position.y = -0.01
    this.shadowFloor.receiveShadow = true
    scene.add(this.shadowFloor)
    scene.add(makeMotes(this))
    scene.add(this.world)

    this.raycaster.params.Line = { threshold: 0.05 }
    this.raycaster.params.Points = { threshold: 0.05 }

    const el = renderer.domElement
    el.addEventListener('pointermove', this.onPointerMove)
    el.addEventListener('pointerdown', this.onPointerDown)
    el.addEventListener('pointerup', this.onPointerUp)
    el.addEventListener('pointerleave', () => this.setHovered(null))

    this.timer.connect(document)
    new ResizeObserver(() => this.resize()).observe(container)
    this.resize()
    renderer.setAnimationLoop(this.frame)
  }

  setQuality(q: Quality) {
    this.quality = q
    const dpr = q === 'high' ? Math.min(window.devicePixelRatio, 2) : Math.min(window.devicePixelRatio, 1.25)
    this.renderer.setPixelRatio(dpr)
    this.renderer.shadowMap.enabled = q === 'high'
    this.keyLight.castShadow = q === 'high'
    this.shadowFloor.visible = q === 'high'
    this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined
      if (m) m.needsUpdate = true
    })
    if (q === 'high') {
      const composer = new EffectComposer(this.renderer)
      composer.addPass(new RenderPass(this.scene, this.camera))
      composer.addPass(new UnrealBloomPass(new THREE.Vector2(this.size.w, this.size.h), 0.42, 0.45, 0.85))
      composer.addPass(new OutputPass())
      this.composer?.dispose()
      this.composer = composer
    } else {
      this.composer?.dispose()
      this.composer = null
    }
    this.resize()
  }

  getQuality() {
    return this.quality
  }

  /** Screen area covered by HUD panels; the 3D view is re-centred in what remains. */
  setInsets(insets: Insets) {
    this.insets = insets
    this.applyViewOffset()
  }

  onUpdate(fn: (dt: number, t: number) => void) {
    this.updaters.add(fn)
    return () => {
      this.updaters.delete(fn)
    }
  }

  pick(obj: THREE.Object3D, handlers: PickHandlers) {
    this.picks.set(obj, handlers)
    return () => {
      this.picks.delete(obj)
      if (this.hovered === obj) this.setHovered(null)
    }
  }

  /** Smoothly moves the camera. A newer flight interrupts an older one. */
  flyTo(position: THREE.Vector3Like, target: THREE.Vector3Like, seconds = 1.4): Promise<void> {
    const id = ++this.flight
    const p0 = this.camera.position.clone()
    const t0 = this.controls.target.clone()
    const p1 = new THREE.Vector3().copy(position)
    const t1 = new THREE.Vector3().copy(target)
    return new Promise((resolve) => {
      let elapsed = 0
      const stop = this.onUpdate(() => {
        if (id !== this.flight) {
          stop()
          resolve()
          return
        }
        elapsed += this.realDt
        const k = Ease.inOut(Math.min(1, elapsed / Math.max(0.001, seconds)))
        this.camera.position.lerpVectors(p0, p1, k)
        this.controls.target.lerpVectors(t0, t1, k)
        if (k >= 1) {
          stop()
          resolve()
        }
      })
    })
  }

  /** Test hook: clicks the first visible pickable object that matches. */
  debugClick(match: (o: THREE.Object3D) => boolean): boolean {
    for (const [o, h] of this.picks) {
      if (match(o) && isVisible(o)) {
        h.onClick?.({} as THREE.Intersection)
        return true
      }
    }
    return false
  }

  /** Removes and disposes all chapter content. */
  clearWorld() {
    this.picks.clear()
    this.setHovered(null)
    for (const child of [...this.world.children]) {
      this.world.remove(child)
      disposeObject(child)
    }
    // Labels of removed objects linger in the overlay unless cleared; live ones are re-added on the next frame.
    this.labels.domElement.replaceChildren()
    this.controls.autoRotate = false
  }

  worldToScreen(v: THREE.Vector3): { x: number; y: number } {
    const p = v.clone().project(this.camera)
    const rect = this.renderer.domElement.getBoundingClientRect()
    return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height }
  }

  private realDt = 0

  private frame = (time: number) => {
    this.timer.update(time)
    const raw = Math.min(this.timer.getDelta(), 1 / 10)
    this.realDt = raw
    const dt = this.paused ? 0 : raw * this.timeScale
    this.elapsed += dt
    this.anim.update(dt)
    for (const fn of [...this.updaters]) fn(dt, this.elapsed)
    this.controls.update()
    if (this.composer) this.composer.render()
    else this.renderer.render(this.scene, this.camera)
    this.labels.render(this.scene, this.camera)
  }

  private resize() {
    const w = Math.max(1, this.container.clientWidth)
    const h = Math.max(1, this.container.clientHeight)
    this.size = { w, h }
    this.renderer.setSize(w, h)
    this.labels.setSize(w, h)
    this.composer?.setSize(w, h)
    this.composer?.setPixelRatio(this.renderer.getPixelRatio())
    this.camera.aspect = w / h
    // Narrow screens need a wider field of view to fit the same scene.
    this.camera.fov = w / h < 0.8 ? 50 : 42
    this.applyViewOffset()
  }

  private applyViewOffset() {
    const { w, h } = this.size
    const dy = (this.insets.bottom - this.insets.top) / 2
    const dx = (this.insets.right - this.insets.left) / 2
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) this.camera.clearViewOffset()
    else this.camera.setViewOffset(w, h, dx, dy, w, h)
    this.camera.updateProjectionMatrix()
  }

  private hitTest(clientX: number, clientY: number) {
    if (this.picks.size === 0) return null
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(this.ndc, this.camera)
    const hits = this.raycaster.intersectObjects([...this.picks.keys()], true)
    for (const hit of hits) {
      if (!(hit.object as THREE.Mesh).isMesh || !isVisible(hit.object)) continue
      let o: THREE.Object3D | null = hit.object
      while (o) {
        if (this.picks.has(o)) return { obj: o, hit }
        o = o.parent
      }
    }
    return null
  }

  private setHovered(obj: THREE.Object3D | null, x = 0, y = 0) {
    if (obj !== this.hovered) {
      if (this.hovered) this.picks.get(this.hovered)?.onHover?.(false)
      this.hovered = obj
      if (obj) this.picks.get(obj)?.onHover?.(true)
      this.renderer.domElement.style.cursor = obj ? 'pointer' : ''
    }
    const h = obj ? this.picks.get(obj) : undefined
    const tip = h?.tooltip ? (typeof h.tooltip === 'function' ? h.tooltip() : h.tooltip) : ''
    if (tip) {
      this.tooltip.textContent = tip
      this.tooltip.hidden = false
      const r = this.tooltip.getBoundingClientRect()
      const left = Math.min(x + 14, window.innerWidth - r.width - 8)
      const top = Math.max(8, y - r.height - 10)
      this.tooltip.style.transform = `translate(${left}px, ${top}px)`
    } else {
      this.tooltip.hidden = true
    }
  }

  private onPointerMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return
    if (this.down && (e.buttons & 1) !== 0) {
      this.setHovered(null)
      return
    }
    const res = this.hitTest(e.clientX, e.clientY)
    this.setHovered(res?.obj ?? null, e.clientX, e.clientY)
  }

  private onPointerDown = (e: PointerEvent) => {
    this.down = { x: e.clientX, y: e.clientY, t: performance.now() }
  }

  private onPointerUp = (e: PointerEvent) => {
    const d = this.down
    this.down = null
    if (!d) return
    const moved = Math.hypot(e.clientX - d.x, e.clientY - d.y)
    if (moved > 8 || performance.now() - d.t > 700) return
    const res = this.hitTest(e.clientX, e.clientY)
    if (res) this.picks.get(res.obj)?.onClick?.(res.hit)
  }
}

function isVisible(o: THREE.Object3D | null): boolean {
  while (o) {
    if (!o.visible) return false
    o = o.parent
  }
  return true
}

export function disposeObject(root: THREE.Object3D) {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (mesh.geometry && !mesh.geometry.userData.shared) mesh.geometry.dispose()
    const mats = mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : []
    for (const m of mats) if (!m.userData.shared) m.dispose()
  })
}

function makeGridFloor() {
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uMinor: { value: new THREE.Color('#1a2a4a') },
      uMajor: { value: new THREE.Color('#2f4f86') },
      uFade: { value: 70 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uMinor;
      uniform vec3 uMajor;
      uniform float uFade;
      varying vec3 vPos;
      float line(vec2 p, float size) {
        vec2 q = p / size;
        vec2 g = abs(fract(q - 0.5) - 0.5) / fwidth(q);
        return 1.0 - min(min(g.x, g.y), 1.0);
      }
      void main() {
        float minor = line(vPos.xz, 1.0);
        float major = line(vPos.xz, 6.0);
        float d = length(vPos.xz);
        float fade = 1.0 - smoothstep(uFade * 0.25, uFade, d);
        vec3 col = mix(uMinor, uMajor, major);
        float a = max(minor * 0.45, major * 0.9) * fade;
        gl_FragColor = vec4(col, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  })
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(240, 240), mat)
  floor.rotation.x = -Math.PI / 2
  floor.renderOrder = -1
  return floor
}

/** Slowly rising specks of light, for atmosphere. */
function makeMotes(ticker: Ticker) {
  const count = 260
  const pos = new Float32Array(count * 3)
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 70
    pos[i * 3 + 1] = Math.random() * 24
    pos[i * 3 + 2] = (Math.random() - 0.5) * 70
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  const mat = new THREE.PointsMaterial({
    color: '#7fb4ff',
    size: 0.07,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })
  const pts = new THREE.Points(geo, mat)
  ticker.onUpdate((dt) => {
    for (let i = 0; i < count; i++) {
      let y = pos[i * 3 + 1] + dt * (0.25 + (i % 7) * 0.05)
      if (y > 24) y = 0
      pos[i * 3 + 1] = y
    }
    geo.attributes.position.needsUpdate = true
  })
  return pts
}
