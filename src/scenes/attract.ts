import * as THREE from 'three'
import type { Stage } from '../engine/stage'
import type { Scope } from '../engine/anim'
import { BlockView, Beam, DriveView, C, v3, pulse } from '../engine/kit'

/** The title screen backdrop: a pool of drives with its block tree hovering above. */
export function buildAttract(stage: Stage, scope: Scope) {
  const root = new THREE.Group()
  stage.world.add(root)

  const drives: DriveView[] = []
  const n = 8
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    const d = new DriveView(`sd${String.fromCharCode(97 + i)}`, '4T')
    d.position.set(Math.cos(a) * 6.5, 0, Math.sin(a) * 6.5)
    d.rotation.y = -a + Math.PI / 2
    d.label.visible = false
    root.add(d)
    drives.push(d)
  }

  // A small tree: uberblock -> MOS -> objset -> dnode -> L1 -> L0s.
  const spec: Array<{ color: string; pos: THREE.Vector3; parent: number }> = [
    { color: C.uber, pos: v3(0, 9.2, 0), parent: -1 },
    { color: C.mos, pos: v3(0, 7.7, 0), parent: 0 },
    { color: C.objset, pos: v3(-1.6, 6.2, 0), parent: 1 },
    { color: C.objset, pos: v3(1.6, 6.2, 0), parent: 1 },
    { color: C.dnode, pos: v3(-1.6, 4.7, 0), parent: 2 },
    { color: C.dnode, pos: v3(1.6, 4.7, 0), parent: 3 },
    { color: C.indirect, pos: v3(-2.6, 3.2, 0), parent: 4 },
    { color: C.indirect, pos: v3(-0.6, 3.2, 0), parent: 4 },
    { color: C.indirect, pos: v3(1.6, 3.2, 0), parent: 5 },
  ]
  const leaves: number[] = []
  const xs = [-3.4, -2.6, -1.8, -1.0, -0.2, 0.9, 1.6, 2.3, 3.0]
  const parentsOfLeaves = [6, 6, 6, 7, 7, 8, 8, 8, 8]
  xs.forEach((x, i) => {
    leaves.push(spec.length)
    spec.push({ color: C.data, pos: v3(x, 1.7, 0), parent: parentsOfLeaves[i] })
  })

  const blocks = spec.map((s, i) => {
    const b = new BlockView(s.color, i === 0 ? 0.85 : i < 9 ? 0.6 : 0.5, 0.5)
    b.position.copy(s.pos)
    root.add(b)
    return b
  })
  spec.forEach((s) => {
    if (s.parent < 0) return
    const beam = new Beam(C.ghost, 0.025, 0.6)
    beam.set(spec[s.parent].pos, s.pos)
    root.add(beam)
  })

  scope.onUpdate((_dt, t) => {
    root.rotation.y = t * 0.08
    blocks.forEach((b, i) => {
      b.position.y = spec[i].pos.y + Math.sin(t * 1.2 + i * 0.7) * 0.05
    })
  })

  // Every so often, a read travels from the uberblock down to a random leaf.
  scope.run(async () => {
    for (;;) {
      await scope.sleep(1.6)
      const leaf = leaves[Math.floor(Math.random() * leaves.length)]
      const path: THREE.Vector3[] = []
      for (let i = leaf; i >= 0; i = spec[i].parent) path.unshift(blocks[i].position.clone())
      await pulse(scope, root, path, C.uber, 1.4, 0.1)
      void blocks[leaf].flash(scope, C.white, 0.5).catch(() => {})
      drives[Math.floor(Math.random() * n)].setSelected(true, C.data)
      await scope.sleep(0.4)
      drives.forEach((d) => d.setSelected(false))
    }
  })

  stage.camera.position.set(-9, 8.5, 17)
  stage.controls.target.set(-3.5, 4.2, 0)
}
