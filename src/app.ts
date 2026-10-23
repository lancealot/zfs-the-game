import { Stage, type Quality } from './engine/stage'
import { Scope } from './engine/anim'
import { Hud } from './ui/hud'
import { Sound } from './ui/sound'
import { Modal, runQuiz, showResults, openCodex } from './ui/modals'
import { h, stars } from './ui/dom'
import { Progress } from './state/progress'
import { CODEX_BY_ID, CODEX } from './content/codex'
import { Ctx, type ChapterDef, type AppServices } from './chapters/types'
import { CHAPTERS } from './chapters'
import { buildAttract } from './scenes/attract'

export class App implements AppServices {
  readonly stage: Stage
  readonly hud: Hud
  readonly sound = new Sound()
  readonly progress = new Progress()
  readonly modal: Modal
  private menuEl: HTMLElement
  private scope: Scope | null = null
  private current: ChapterDef | null = null

  constructor(root: HTMLElement) {
    const stageEl = h('div', { id: 'stage' })
    const tooltip = h('div', { class: 'tooltip', hidden: true })
    root.append(stageEl, tooltip)
    this.stage = new Stage(stageEl, tooltip)
    this.hud = new Hud(root, this.sound)
    this.modal = new Modal(root)
    this.menuEl = h('div', { class: 'menu', hidden: true })
    root.append(this.menuEl)

    const s = this.progress.settings
    this.sound.enabled = s.sound
    this.stage.timeScale = s.speed
    this.stage.setQuality(s.quality ?? defaultQuality())

    this.hud.titleOf = (id) => CODEX_BY_ID.get(id)?.title
    this.hud.onCodex = (id) => openCodex(this.modal, this.progress, id)
    this.hud.onMenu = () => this.showMenu()
    this.hud.onSettings = () => this.openSettings()
    this.hud.onLayout((i) => this.stage.setInsets(i))
  }

  start() {
    const hash = location.hash.replace('#', '')
    const ch = CHAPTERS.find((c) => c.id === hash)
    if (ch) this.play(ch)
    else this.showMenu()
  }

  // ----------------------------------------------------------------- flow

  private teardown() {
    this.scope?.dispose()
    this.scope = null
    this.current = null
    this.modal.close()
    this.hud.reset()
    this.stage.clearWorld()
  }

  showMenu() {
    this.teardown()
    this.hud.show(false)
    const scope = new Scope(this.stage)
    this.scope = scope
    buildAttract(this.stage, scope)
    this.renderMenu()
    this.menuEl.hidden = false
    try {
      history.replaceState(null, '', location.pathname + location.search)
    } catch {
      /* sandboxed frames may refuse */
    }
  }

  play(def: ChapterDef) {
    this.teardown()
    this.menuEl.hidden = true
    this.hud.show(true)
    this.hud.setChapter(def.num, def.title)
    this.current = def
    try {
      history.replaceState(null, '', `#${def.id}`)
    } catch {
      /* ignore */
    }
    const scope = new Scope(this.stage)
    this.scope = scope
    const ctx = new Ctx(this, def, scope)
    scope.run(
      () => def.run(ctx),
      (e) => {
        console.error(e)
        this.hud.toast('Something went wrong in this chapter. Try replaying it.', 'bad', 5000)
      },
    )
  }

  async finishChapter(def: ChapterDef) {
    this.hud.hideDialog()
    const correct = await runQuiz(this.modal, this.sound, def.title, def.quiz, (id) => CODEX_BY_ID.get(id)?.title)
    const total = def.quiz.length
    const starCount = 1 + (correct >= Math.ceil(total / 2) ? 1 : 0) + (correct === total ? 1 : 0)
    this.progress.record(def.id, starCount)
    const idx = CHAPTERS.indexOf(def)
    const next = CHAPTERS[idx + 1]
    const choice = await showResults(this.modal, this.sound, {
      title: def.title,
      stars: starCount,
      correct,
      total,
      hasNext: !!next,
      summary: def.summary,
    }, (id) => CODEX_BY_ID.get(id)?.title)
    // Defer so the chapter's own promise chain unwinds before teardown.
    setTimeout(() => {
      if (this.current !== def) return
      if (choice === 'next' && next) this.play(next)
      else if (choice === 'replay') this.play(def)
      else this.showMenu()
    }, 0)
  }

  private pendingCodex: string[] = []

  /** Unlocks are batched so a burst of new entries makes one toast. */
  unlockCodex(id: string) {
    const e = CODEX_BY_ID.get(id)
    if (!e || !this.progress.unlockCodex(id)) return
    this.pendingCodex.push(e.title)
    if (this.pendingCodex.length > 1) return
    setTimeout(() => {
      const t = this.pendingCodex
      this.pendingCodex = []
      this.hud.toast(t.length === 1 ? `Codex: **${t[0]}** added` : `Codex: ${t.length} entries added (${t.join(', ')})`, 'codex', 3200)
    }, 60)
  }

  // ----------------------------------------------------------------- menu

  private renderMenu() {
    const firstOpen = CHAPTERS.find((c) => !this.progress.chapter(c.id).done)
    const totalStars = CHAPTERS.reduce((n, c) => n + this.progress.chapter(c.id).stars, 0)
    const anyDone = CHAPTERS.some((c) => this.progress.chapter(c.id).done)
    const cards = CHAPTERS.map((c) => {
      const rec = this.progress.chapter(c.id)
      return h(
        'button',
        {
          class: `ch-card${rec.done ? ' done' : ''}`,
          onclick: () => {
            this.sound.click()
            this.play(c)
          },
        },
        h('div', { class: 'n' }, h('span', null, `CHAPTER ${String(c.num).padStart(2, '0')}`), h('span', { html: stars(rec.stars, 3, true) })),
        h('div', { class: 't' }, c.title),
        h('div', { class: 'd' }, c.tagline),
        h('div', { class: 'tags' }, ...c.tags.map((t) => h('span', null, t))),
      )
    })
    const startLabel = !anyDone ? 'Start the tour' : firstOpen ? `Continue: ${firstOpen.title}` : 'Replay from the start'
    this.menuEl.replaceChildren(
      h(
        'div',
        { class: 'menu-inner' },
        h(
          'header',
          null,
          h('div', { class: 'kicker', html: 'ub_magic <b>0x00bab10c</b> · a game about the file system that checks its own work' }),
          h('h1', null, h('span', { class: 'z' }, 'ZFS'), ', the Game', h('span', { class: 'sub' }, 'Learn ZFS from the inside, one block at a time')),
          h(
            'p',
            { class: 'lede' },
            'Nine hands-on chapters, from building a pool to following checksums through the block tree. Break disks, pull the plug mid-write, fight bit rot, and type real zpool commands while you watch the blocks move.',
          ),
          h(
            'div',
            { class: 'cta' },
            h(
              'button',
              {
                class: 'btn primary',
                onclick: () => {
                  this.sound.click()
                  this.play(firstOpen ?? CHAPTERS[0])
                },
              },
              startLabel,
            ),
            h('button', { class: 'btn ghost', onclick: () => openCodex(this.modal, this.progress) }, 'Codex'),
            h('button', { class: 'btn ghost', onclick: () => this.openSettings() }, 'Settings'),
            anyDone ? h('span', { class: 'mono', style: { color: 'var(--fg-dim)' } }, `★ ${totalStars} / ${CHAPTERS.length * 3}`) : null,
          ),
        ),
        h('section', { class: 'chapters', 'aria-label': 'Chapters' }, ...cards),
        h(
          'footer',
          null,
          h('span', null, 'Drag to orbit · scroll or pinch to zoom · right-drag to pan'),
          h('span', null, `Codex: ${CODEX.filter((e) => this.progress.hasCodex(e.id)).length}/${CODEX.length} entries`),
          h('span', null, 'An unofficial fan project, not affiliated with OpenZFS.'),
        ),
      ),
    )
  }

  // ------------------------------------------------------------- settings

  openSettings() {
    const s = this.progress.settings
    const seg = <T extends string | number | boolean>(id: string, options: Array<[T, string]>, value: T, set: (v: T) => void) => {
      const wrap = h('div', { class: 'seg', role: 'group', id })
      const render = (cur: T) => {
        wrap.replaceChildren(
          ...options.map(([v, label]) =>
            h(
              'button',
              {
                class: v === cur ? 'on' : '',
                'aria-pressed': String(v === cur),
                onclick: () => {
                  set(v)
                  render(v)
                },
              },
              label,
            ),
          ),
        )
      }
      render(value)
      return wrap
    }
    const confirmRow = h('div', { class: 'row', hidden: true, style: { justifyContent: 'flex-start', marginTop: '8px' } })
    const card = h(
      'div',
      { class: 'card' },
      h('h2', null, 'Settings'),
      h(
        'div',
        { class: 'setting' },
        h('label', { for: 'set-quality' }, 'Graphics', h('small', null, 'High adds glow and soft shadows.')),
        seg<Quality>('set-quality', [['high', 'High'], ['low', 'Low']], this.stage.getQuality(), (v) => {
          this.stage.setQuality(v)
          this.progress.setSettings({ quality: v })
        }),
      ),
      h(
        'div',
        { class: 'setting' },
        h('label', { for: 'set-speed' }, 'Animation speed', h('small', null, 'Speeds up block animations and simulations.')),
        seg<number>('set-speed', [[1, '1×'], [1.5, '1.5×'], [2, '2×']], s.speed, (v) => {
          this.stage.timeScale = v
          this.progress.setSettings({ speed: v })
        }),
      ),
      h(
        'div',
        { class: 'setting' },
        h('label', { for: 'set-sound' }, 'Sound effects'),
        seg<boolean>('set-sound', [[true, 'On'], [false, 'Off']], s.sound, (v) => {
          this.sound.enabled = v
          this.progress.setSettings({ sound: v })
          if (v) this.sound.click()
        }),
      ),
      h(
        'div',
        { class: 'setting' },
        h('label', null, 'Progress', h('small', null, 'Stars and Codex entries are saved in this browser.')),
        h(
          'button',
          {
            class: 'btn danger',
            onclick: () => {
              confirmRow.hidden = false
            },
          },
          'Reset…',
        ),
      ),
      confirmRow,
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => this.modal.close() }, 'Done')),
    )
    confirmRow.append(
      h('span', { style: { color: 'var(--fg-dim)', alignSelf: 'center' } }, 'Erase all stars and Codex entries?'),
      h(
        'button',
        {
          class: 'btn danger',
          onclick: () => {
            this.progress.reset()
            this.modal.close()
            this.hud.toast('Progress reset', 'ok')
            if (!this.menuEl.hidden) this.renderMenu()
          },
        },
        'Erase',
      ),
      h('button', { class: 'btn ghost', onclick: () => (confirmRow.hidden = true) }, 'Cancel'),
    )
    this.modal.open(card, { onClose: () => !this.menuEl.hidden && this.renderMenu() })
  }
}

function defaultQuality(): Quality {
  const coarse = window.matchMedia('(pointer: coarse)').matches
  const small = Math.min(window.innerWidth, window.innerHeight) < 600
  return coarse && small ? 'low' : 'high'
}

