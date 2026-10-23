import type { Quality } from '../engine/stage'

export interface ChapterRecord {
  stars: number
  done: boolean
}

export interface Settings {
  quality: Quality | null
  speed: number
  sound: boolean
}

interface SaveData {
  v: 1
  chapters: Record<string, ChapterRecord>
  codex: string[]
  settings: Settings
}

const KEY = 'zfs-the-game:v1'

const fresh = (): SaveData => ({
  v: 1,
  chapters: {},
  codex: [],
  settings: { quality: null, speed: 1, sound: true },
})

/** Saved progress. Storage can be unavailable (private windows, sandboxes), so every access is guarded. */
export class Progress {
  private data: SaveData

  constructor() {
    this.data = fresh()
    try {
      const raw = localStorage.getItem(KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<SaveData>
        if (parsed.v === 1) {
          this.data = { ...fresh(), ...parsed, settings: { ...fresh().settings, ...parsed.settings } } as SaveData
        }
      }
    } catch {
      /* storage unavailable: play without saving */
    }
  }

  private save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data))
    } catch {
      /* ignore */
    }
  }

  chapter(id: string): ChapterRecord {
    return this.data.chapters[id] ?? { stars: 0, done: false }
  }

  record(id: string, stars: number) {
    const prev = this.chapter(id)
    this.data.chapters[id] = { done: true, stars: Math.max(prev.stars, stars) }
    this.save()
  }

  hasCodex(id: string) {
    return this.data.codex.includes(id)
  }

  /** Returns true if this unlock is new. */
  unlockCodex(id: string) {
    if (this.data.codex.includes(id)) return false
    this.data.codex.push(id)
    this.save()
    return true
  }

  get settings(): Settings {
    return this.data.settings
  }

  setSettings(patch: Partial<Settings>) {
    this.data.settings = { ...this.data.settings, ...patch }
    this.save()
  }

  reset() {
    const settings = this.data.settings
    this.data = { ...fresh(), settings }
    this.save()
  }
}
