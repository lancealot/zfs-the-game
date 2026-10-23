import { h, fmt, ICON, DITTO_SVG } from './dom'
import type { Sound } from './sound'
import { Terminal } from './terminal'
import type { Insets } from '../engine/stage'

export interface ActionSpec {
  id: string
  label: string
  /** The equivalent shell command, shown under the label. */
  cmd?: string
  kind?: 'primary' | 'danger' | 'ghost'
  disabled?: boolean
  hidden?: boolean
  glow?: boolean
  onClick: () => void
}

export interface Choice {
  id: string
  label: string
  kind?: 'primary' | 'danger' | 'ghost'
}

export interface SayOptions {
  /** Show a continue button; a string sets its label. */
  next?: boolean | string
  choices?: Choice[]
  who?: string
}

export interface Chip {
  k?: string
  v: string
  kind?: 'ok' | 'warn' | 'bad'
  narrowHide?: boolean
}

interface Objective {
  id: string
  text: string
  done: boolean
}

/** All on-screen chrome during a chapter. */
export class Hud {
  readonly el: HTMLElement
  readonly term: Terminal
  /** Called when a [[codex]] link in narration is clicked. */
  onCodex: (id: string) => void = () => {}
  onMenu: () => void = () => {}
  onSettings: () => void = () => {}
  titleOf: (id: string) => string | undefined = () => undefined

  private chapterNum: HTMLElement
  private chapterName: HTMLElement
  private statsEl: HTMLElement
  private objEl: HTMLElement
  private objList: HTMLElement
  private infoEl: HTMLElement
  private inspEl: HTMLElement
  private dialogEl: HTMLElement
  private dialogText: HTMLElement
  private dialogWho: HTMLElement
  private dialogControls: HTMLElement
  private actionsEl: HTMLElement
  private toastsEl: HTMLElement
  private topbar: HTMLElement
  private dock: HTMLElement
  private objectives: Objective[] = []
  private actionMap = new Map<string, { spec: ActionSpec; btn: HTMLButtonElement }>()
  private sayResolve: ((id: string) => void) | null = null
  private inspectClose: (() => void) | null = null
  private layoutCb: ((i: Insets) => void) | null = null
  private termToggle: HTMLButtonElement

  constructor(
    root: HTMLElement,
    private sound: Sound,
  ) {
    this.term = new Terminal(sound)

    this.chapterNum = h('span', { class: 'num' })
    this.chapterName = h('span', { class: 'name' })
    this.statsEl = h('div', { class: 'top-stats' })
    this.topbar = h(
      'header',
      { class: 'topbar' },
      h('button', { class: 'brand', title: 'Chapters', 'aria-label': 'Back to chapter select', onclick: () => this.onMenu() }, 'ZFS', h('span', null, ', the Game')),
      h('div', { class: 'chapter-title panel' }, this.chapterNum, this.chapterName),
      this.statsEl,
      h(
        'div',
        { class: 'top-actions' },
        h('button', { class: 'icon-btn', title: 'Chapters', 'aria-label': 'Chapters', html: ICON.grid, onclick: () => this.onMenu() }),
        h('button', { class: 'icon-btn', title: 'Codex', 'aria-label': 'Codex', html: `${ICON.book}`, onclick: () => this.onCodex('') }),
        h('button', { class: 'icon-btn', title: 'Settings', 'aria-label': 'Settings', html: ICON.gear, onclick: () => this.onSettings() }),
      ),
    )

    this.objList = h('ul')
    this.objEl = h(
      'section',
      { class: 'objectives panel', 'aria-label': 'Objectives' },
      h('h3', null, 'Objectives'),
      this.objList,
      h('button', { class: 'toggle', 'aria-label': 'Show all objectives', onclick: () => this.objEl.classList.toggle('open') }),
    )
    this.infoEl = h('section', { class: 'info panel' })
    this.inspEl = h('aside', { class: 'inspector panel', hidden: true, 'aria-live': 'polite' })

    this.dialogWho = h('div', { class: 'who' }, 'Ditto')
    this.dialogText = h('div', { class: 'text' })
    this.dialogControls = h('div', { class: 'controls' })
    this.dialogEl = h(
      'section',
      { class: 'dialog panel', hidden: true, 'aria-live': 'polite' },
      h('div', { html: DITTO_SVG }),
      h('div', null, this.dialogWho, this.dialogText, this.dialogControls),
    )
    this.dialogText.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('[data-codex]') as HTMLElement | null
      if (t) this.onCodex(t.dataset.codex!)
    })

    this.termToggle = h(
      'button',
      { class: 'btn term-toggle-mobile', onclick: () => this.term.toggle() },
      h('span', { html: ICON.term, style: { width: '16px', height: '16px', display: 'inline-flex' } }),
      'Terminal',
    )
    this.actionsEl = h('div', { class: 'actions' })
    this.dock = h(
      'section',
      { class: 'dock' },
      this.dialogEl,
      h('div', { class: 'side' }, this.actionsEl, this.term.el),
    )

    this.el = h(
      'div',
      { class: 'hud', hidden: true },
      this.topbar,
      h('div', { class: 'middle' }, h('div', { class: 'left-col' }, this.objEl), h('div', { class: 'right-col' }, this.infoEl, this.inspEl)),
      this.dock,
    )
    this.toastsEl = h('div', { class: 'toasts', 'aria-live': 'polite' })
    root.append(this.el, this.toastsEl)

    window.addEventListener('keydown', (e) => {
      if (this.el.hidden) return
      const tag = (document.activeElement?.tagName ?? '').toLowerCase()
      if (tag === 'input' || tag === 'textarea') return
      if (e.key === 'Enter' && this.sayResolve && (tag === 'body' || tag === '')) {
        const btn = this.dialogControls.querySelector<HTMLButtonElement>('button[data-next]')
        if (btn && document.querySelector('.modal:not([hidden])') === null) {
          e.preventDefault()
          btn.click()
        }
      }
    })

    const ro = new ResizeObserver(() => this.emitLayout())
    ro.observe(this.topbar)
    ro.observe(this.dock)
    window.addEventListener('resize', () => this.emitLayout())
  }

  onLayout(cb: (i: Insets) => void) {
    this.layoutCb = cb
    this.emitLayout()
  }

  private emitLayout() {
    if (!this.layoutCb) return
    if (this.el.hidden) {
      this.layoutCb({ top: 0, bottom: 0, left: 0, right: 0 })
      return
    }
    const top = this.topbar.getBoundingClientRect().bottom
    // The dialog is what really covers the middle of the scene; the terminal sits off to the side.
    const narrow = window.innerWidth <= 860
    const covering = narrow ? this.dock : this.dialogEl.hidden ? null : this.dialogEl
    const bottom = covering ? Math.max(0, window.innerHeight - covering.getBoundingClientRect().top) : 0
    document.documentElement.style.setProperty('--dock-cover', `${Math.round(bottom)}px`)
    this.layoutCb({ top, bottom, left: 0, right: 0 })
  }

  show(on: boolean) {
    this.el.hidden = !on
    this.emitLayout()
  }

  setChapter(num: number | null, title: string) {
    this.chapterNum.textContent = num === null ? '' : `Chapter ${num}`
    this.chapterName.textContent = title
  }

  stats(chips: Chip[]) {
    this.statsEl.replaceChildren(
      ...chips.map((c) =>
        h(
          'span',
          { class: `chip${c.kind ? ` ${c.kind}` : ''}${c.narrowHide ? ' hide-narrow' : ''}` },
          c.k ? h('span', { class: 'k' }, c.k) : null,
          c.v,
        ),
      ),
    )
  }

  // ------------------------------------------------------------ objectives

  setObjectives(list: Array<{ id: string; text: string }>) {
    this.objectives = list.map((o) => ({ ...o, done: false }))
    this.renderObjectives()
  }

  check(id: string) {
    const o = this.objectives.find((x) => x.id === id)
    if (!o || o.done) return
    o.done = true
    this.sound.ok()
    this.renderObjectives(id)
  }

  isDone(id: string) {
    return this.objectives.find((x) => x.id === id)?.done ?? false
  }

  private renderObjectives(justDone?: string) {
    const current = this.objectives.find((o) => !o.done)
    this.objEl.hidden = this.objectives.length === 0
    this.objList.replaceChildren(
      ...this.objectives.map((o) =>
        h(
          'li',
          { class: `${o.done ? 'done' : ''} ${o === current ? 'current' : ''} ${o.id === justDone ? 'just-done' : ''}` },
          h('span', { class: 'box' }),
          h('span', { html: fmt(o.text, this.titleOf).replace(/^<p>|<\/p>$/g, '') }),
        ),
      ),
    )
  }

  // -------------------------------------------------------------- dialog

  /**
   * Shows a line from Ditto. Resolves with the chosen id (or 'next') once
   * the player responds, or immediately when there's nothing to click.
   */
  say(text: string, opts: SayOptions = {}): Promise<string> {
    if (this.sayResolve) {
      const r = this.sayResolve
      this.sayResolve = null
      r('superseded')
    }
    this.dialogEl.hidden = false
    this.dialogWho.textContent = opts.who ?? 'Ditto'
    this.dialogText.innerHTML = fmt(text, this.titleOf)
    this.dialogEl.classList.remove('fresh')
    void this.dialogEl.offsetWidth
    this.dialogEl.classList.add('fresh')
    this.dialogEl.scrollTop = 0
    this.dialogControls.replaceChildren()
    this.emitLayout()

    const choices: Choice[] = opts.choices ?? (opts.next ? [{ id: 'next', label: opts.next === true ? 'Next' : opts.next, kind: 'primary' }] : [])
    if (choices.length === 0) return Promise.resolve('')
    return new Promise((resolve) => {
      this.sayResolve = resolve
      for (const c of choices) {
        const btn = h(
          'button',
          {
            class: `btn ${c.kind ?? ''}`,
            'data-next': c.id === 'next' ? '' : undefined,
            onclick: () => {
              if (this.sayResolve !== resolve) return
              this.sayResolve = null
              this.sound.click()
              this.dialogControls.replaceChildren()
              resolve(c.id)
            },
          },
          c.label,
        )
        this.dialogControls.append(btn)
      }
    })
  }

  hideDialog() {
    this.dialogEl.hidden = true
    this.emitLayout()
  }

  // ------------------------------------------------------------- actions

  setActions(list: ActionSpec[]) {
    this.actionMap.clear()
    this.actionsEl.replaceChildren()
    for (const spec of list) {
      const btn = h('button', { class: 'btn btn-stack' }) as HTMLButtonElement
      btn.addEventListener('click', () => {
        const cur = this.actionMap.get(spec.id)
        if (!cur || cur.spec.disabled) return
        this.sound.click()
        cur.spec.onClick()
      })
      this.actionMap.set(spec.id, { spec: { ...spec }, btn })
      this.renderAction(spec.id)
      this.actionsEl.append(btn)
    }
    this.actionsEl.append(this.termToggle)
    this.emitLayout()
  }

  updateAction(id: string, patch: Partial<ActionSpec>) {
    const a = this.actionMap.get(id)
    if (!a) return
    Object.assign(a.spec, patch)
    this.renderAction(id)
  }

  private renderAction(id: string) {
    const a = this.actionMap.get(id)!
    const { spec, btn } = a
    btn.className = `btn btn-stack ${spec.kind ?? ''} ${spec.glow ? 'glow' : ''}`
    btn.disabled = !!spec.disabled
    btn.hidden = !!spec.hidden
    btn.replaceChildren(h('span', null, spec.label), spec.cmd ? h('span', { class: 'cmd' }, spec.cmd) : '')
  }

  // ------------------------------------------------------- info / inspect

  info(content: HTMLElement | string | null) {
    if (content === null) this.infoEl.replaceChildren()
    else if (typeof content === 'string') this.infoEl.innerHTML = content
    else this.infoEl.replaceChildren(content)
  }

  inspect(opts: { eyebrow?: string; title: string; body: HTMLElement | string; onClose?: () => void }) {
    this.inspectClose?.()
    this.inspectClose = opts.onClose ?? null
    const body = typeof opts.body === 'string' ? h('div', { html: opts.body }) : opts.body
    this.inspEl.replaceChildren(
      h(
        'header',
        null,
        h('h3', null, opts.eyebrow ?? 'Inspector'),
        h('button', { class: 'close-btn', 'aria-label': 'Close inspector', onclick: () => this.closeInspect() }, '×'),
      ),
      h('div', { class: 'title' }, opts.title),
      body,
    )
    this.inspEl.hidden = false
    body.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('[data-codex]') as HTMLElement | null
      if (t) this.onCodex(t.dataset.codex!)
    })
  }

  closeInspect() {
    if (this.inspEl.hidden) return
    this.inspEl.hidden = true
    const cb = this.inspectClose
    this.inspectClose = null
    cb?.()
  }

  // --------------------------------------------------------------- toasts

  toast(text: string, kind: 'ok' | 'bad' | 'codex' | '' = '', ms = 2600) {
    const t = h('div', { class: `toast ${kind}`, html: fmt(text, this.titleOf).replace(/^<p>|<\/p>$/g, '') })
    this.toastsEl.append(t)
    while (this.toastsEl.children.length > 3) this.toastsEl.firstElementChild?.remove()
    setTimeout(() => {
      t.classList.add('out')
      setTimeout(() => t.remove(), 350)
    }, ms)
  }

  /** Clears everything a chapter put on screen. */
  reset() {
    if (this.sayResolve) {
      const r = this.sayResolve
      this.sayResolve = null
      r('superseded')
    }
    this.setObjectives([])
    this.info(null)
    this.inspectClose = null
    this.inspEl.hidden = true
    this.dialogEl.hidden = true
    this.dialogControls.replaceChildren()
    this.setActions([])
    this.stats([])
    this.objEl.classList.remove('open')
    this.term.reset()
  }
}
