/**
 * A tiny tween engine driven by the render loop, plus `Scope`, which ties
 * animations, timers and listeners to a chapter so they can all be cancelled
 * at once when the player leaves.
 */

export type EaseFn = (t: number) => number

export const Ease = {
  linear: (t: number) => t,
  in: (t: number) => t * t * t,
  out: (t: number) => 1 - Math.pow(1 - t, 3),
  inOut: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  inOutSine: (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,
  outBack: (t: number) => {
    const c1 = 1.70158
    const c3 = c1 + 1
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
  },
} satisfies Record<string, EaseFn>

/** Thrown into pending awaits when their scope is disposed. */
export class Cancelled extends Error {
  constructor() {
    super('cancelled')
    this.name = 'Cancelled'
  }
}

export const isCancelled = (e: unknown): e is Cancelled => e instanceof Cancelled

interface Tween {
  elapsed: number
  duration: number
  fn: (k: number) => void
  ease: EaseFn
  resolve: () => void
  reject: (e: unknown) => void
  owner: unknown
}

export class Animator {
  private tweens = new Set<Tween>()

  /** Animate k from 0 to 1 over `seconds`. */
  add(seconds: number, fn: (k: number) => void, ease: EaseFn = Ease.inOut, owner?: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      if (seconds <= 0) {
        fn(1)
        resolve()
        return
      }
      this.tweens.add({ elapsed: 0, duration: seconds, fn, ease, resolve, reject, owner })
    })
  }

  update(dt: number) {
    for (const tw of [...this.tweens]) {
      tw.elapsed += dt
      const t = Math.min(1, tw.elapsed / tw.duration)
      tw.fn(tw.ease(t))
      if (t >= 1) {
        this.tweens.delete(tw)
        tw.resolve()
      }
    }
  }

  cancelOwner(owner: unknown) {
    for (const tw of [...this.tweens]) {
      if (tw.owner === owner) {
        this.tweens.delete(tw)
        tw.reject(new Cancelled())
      }
    }
  }
}

export interface Ticker {
  onUpdate(fn: (dt: number, t: number) => void): () => void
  readonly anim: Animator
}

/**
 * Lifetime container for a chapter. Everything created through a scope is
 * torn down by `dispose()`, and any `await` on a scope promise rejects with
 * `Cancelled`, which unwinds chapter scripts cleanly.
 */
export class Scope {
  private alive = true
  private disposers: Array<() => void> = []
  private pending = new Set<(e: unknown) => void>()

  constructor(private ticker: Ticker) {}

  get isAlive() {
    return this.alive
  }

  check() {
    if (!this.alive) throw new Cancelled()
  }

  tween(seconds: number, fn: (k: number) => void, ease: EaseFn = Ease.inOut): Promise<void> {
    this.check()
    return this.ticker.anim.add(seconds, fn, ease, this)
  }

  /** Waits in game time (respects the speed setting). */
  sleep(seconds: number): Promise<void> {
    return this.tween(seconds, () => {}, Ease.linear)
  }

  /** Resolves on the first frame where `pred()` is true. */
  until(pred: () => boolean): Promise<void> {
    this.check()
    if (pred()) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const off = this.ticker.onUpdate(() => {
        if (pred()) {
          off()
          this.pending.delete(reject)
          resolve()
        }
      })
      this.pending.add((e) => {
        off()
        reject(e)
      })
    })
  }

  /** Rejects with Cancelled if the scope dies before `p` settles. */
  guard<T>(p: Promise<T>): Promise<T> {
    this.check()
    return new Promise<T>((resolve, reject) => {
      const cancel = (e: unknown) => reject(e)
      this.pending.add(cancel)
      p.then(
        (v) => {
          this.pending.delete(cancel)
          if (this.alive) resolve(v)
        },
        (e) => {
          this.pending.delete(cancel)
          reject(e)
        },
      )
    })
  }

  onUpdate(fn: (dt: number, t: number) => void) {
    const off = this.ticker.onUpdate(fn)
    this.disposers.push(off)
    return off
  }

  listen<K extends keyof WindowEventMap>(target: Window, type: K, fn: (e: WindowEventMap[K]) => void): void
  listen<K extends keyof HTMLElementEventMap>(target: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void): void
  listen(target: EventTarget, type: string, fn: (e: Event) => void) {
    target.addEventListener(type, fn)
    this.disposers.push(() => target.removeEventListener(type, fn))
  }

  add(disposer: () => void) {
    this.disposers.push(disposer)
  }

  /** Runs an async script, swallowing cancellation. */
  run(fn: () => Promise<void>, onError?: (e: unknown) => void) {
    fn().catch((e) => {
      if (isCancelled(e)) return
      if (onError) onError(e)
      else console.error(e)
    })
  }

  dispose() {
    if (!this.alive) return
    this.alive = false
    this.ticker.anim.cancelOwner(this)
    const err = new Cancelled()
    for (const rej of [...this.pending]) rej(err)
    this.pending.clear()
    for (const d of this.disposers.reverse()) {
      try {
        d()
      } catch (e) {
        console.error(e)
      }
    }
    this.disposers = []
  }
}

export const lerp = (a: number, b: number, k: number) => a + (b - a) * k
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
