import type * as THREE from 'three'
import type { Scope, EaseFn } from '../engine/anim'
import type { Stage } from '../engine/stage'
import type { Hud, SayOptions } from '../ui/hud'
import type { Terminal } from '../ui/terminal'
import type { Sound } from '../ui/sound'
import type { QuizQuestion } from '../ui/modals'

export interface ChapterDef {
  id: string
  num: number
  title: string
  tagline: string
  tags: string[]
  /** "What you learned" bullets for the results card. */
  summary: string[]
  quiz: QuizQuestion[]
  run(ctx: Ctx): Promise<void>
}

export interface AppServices {
  stage: Stage
  hud: Hud
  sound: Sound
  unlockCodex(id: string): void
  finishChapter(def: ChapterDef): Promise<void>
}

/** Everything a chapter script needs, bound to the chapter's lifetime. */
export class Ctx {
  readonly stage: Stage
  readonly hud: Hud
  readonly term: Terminal
  readonly sound: Sound
  readonly root: THREE.Group

  constructor(
    private app: AppServices,
    readonly def: ChapterDef,
    readonly scope: Scope,
  ) {
    this.stage = app.stage
    this.hud = app.hud
    this.term = app.hud.term
    this.sound = app.sound
    this.root = app.stage.world
  }

  say(text: string, opts?: SayOptions) {
    return this.scope.guard(this.hud.say(text, opts))
  }

  /** Narration with a continue button. */
  async next(text: string, label: string | true = true) {
    await this.say(text, { next: label })
  }

  choose(text: string, choices: SayOptions['choices']) {
    return this.say(text, { choices })
  }

  objectives(list: Array<{ id: string; text: string }>) {
    this.hud.setObjectives(list)
  }

  check(id: string) {
    this.hud.check(id)
  }

  unlock(...ids: string[]) {
    for (const id of ids) this.app.unlockCodex(id)
  }

  sleep(seconds: number) {
    return this.scope.sleep(seconds)
  }

  tween(seconds: number, fn: (k: number) => void, ease?: EaseFn) {
    return this.scope.tween(seconds, fn, ease)
  }

  until(pred: () => boolean) {
    return this.scope.until(pred)
  }

  /** Moves the camera, pulling back on narrow screens so the same scene still fits. */
  fly(pos: THREE.Vector3Like, target: THREE.Vector3Like, seconds = 1.4) {
    const cam = this.stage.camera
    const halfW = Math.tan(((cam.fov * Math.PI) / 180) / 2) * cam.aspect
    const k = Math.min(2.1, Math.max(1, 0.5 / halfW))
    const p = {
      x: target.x + (pos.x - target.x) * k,
      y: target.y + (pos.y - target.y) * k,
      z: target.z + (pos.z - target.z) * k,
    }
    return this.scope.guard(this.stage.flyTo(p, target, seconds))
  }

  /** Quiz, stars and the results card. Call at the end of `run`. */
  finish() {
    return this.scope.guard(this.app.finishChapter(this.def))
  }
}
