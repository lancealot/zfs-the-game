import { h, fmt, stars, esc } from './dom'
import type { Sound } from './sound'
import { CODEX, CODEX_BY_ID, CODEX_GROUPS } from '../content/codex'
import type { Progress } from '../state/progress'

export class Modal {
  readonly el: HTMLElement
  private onClose: (() => void) | null = null
  private dismissable = true

  constructor(root: HTMLElement) {
    this.el = h('div', { class: 'modal', hidden: true, role: 'dialog', 'aria-modal': 'true' })
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el && this.dismissable) this.close()
    })
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.el.hidden && this.dismissable) this.close()
    })
    root.append(this.el)
  }

  get isOpen() {
    return !this.el.hidden
  }

  open(card: HTMLElement, opts: { dismissable?: boolean; onClose?: () => void } = {}) {
    this.dismissable = opts.dismissable ?? true
    this.onClose = opts.onClose ?? null
    this.el.replaceChildren(card)
    this.el.hidden = false
    const focusable = card.querySelector<HTMLElement>('button.primary, button, [tabindex]')
    focusable?.focus({ preventScroll: true })
  }

  close() {
    if (this.el.hidden) return
    this.el.hidden = true
    this.el.replaceChildren()
    const cb = this.onClose
    this.onClose = null
    cb?.()
  }
}

// ----------------------------------------------------------------- quiz

export interface QuizQuestion {
  q: string
  options: string[]
  /** Index into `options` of the right answer. */
  answer: number
  explain: string
}

function shuffled<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** Resolves with the number of questions answered correctly on the first try. */
export function runQuiz(modal: Modal, sound: Sound, chapterTitle: string, questions: QuizQuestion[], titleOf: (id: string) => string | undefined): Promise<number> {
  return new Promise((resolve) => {
    let idx = 0
    let correct = 0
    const show = () => {
      const q = questions[idx]
      const order = shuffled(q.options.map((text, i) => ({ text, right: i === q.answer })))
      const explain = h('div', { class: 'explain', hidden: true })
      const nextBtn = h('button', { class: 'btn primary', hidden: true }, idx === questions.length - 1 ? 'See results' : 'Next question')
      const opts = order.map((o) => {
        const b = h('button', { class: 'btn opt', html: fmt(o.text).replace(/^<p>|<\/p>$/g, '') }) as HTMLButtonElement
        b.addEventListener('click', () => {
          for (const other of optEls) other.disabled = true
          if (o.right) {
            correct++
            b.classList.add('right')
            sound.ok()
          } else {
            b.classList.add('wrong')
            optEls[order.findIndex((x) => x.right)].classList.add('right')
            sound.bad()
          }
          explain.innerHTML = `<b>${o.right ? 'Correct.' : 'Not quite.'}</b> ${fmt(q.explain, titleOf).replace(/^<p>|<\/p>$/g, '')}`
          explain.hidden = false
          nextBtn.hidden = false
          nextBtn.focus()
        })
        return b
      })
      const optEls = opts
      nextBtn.addEventListener('click', () => {
        idx++
        if (idx < questions.length) show()
        else {
          modal.close()
          resolve(correct)
        }
      })
      const card = h(
        'div',
        { class: 'card quiz' },
        h('div', { class: 'eyebrow' }, `Checkpoint · ${chapterTitle}`),
        h('div', { class: 'progress' }, ...questions.map((_, i) => h('i', { class: i <= idx ? 'done' : '' }))),
        h('div', { class: 'q', html: fmt(q.q, titleOf).replace(/^<p>|<\/p>$/g, '') }),
        h('div', { class: 'opts' }, ...opts),
        explain,
        h('div', { class: 'row' }, nextBtn),
      )
      modal.open(card, { dismissable: false })
    }
    show()
  })
}

// --------------------------------------------------------------- results

export function showResults(
  modal: Modal,
  sound: Sound,
  opts: { title: string; stars: number; correct: number; total: number; hasNext: boolean; summary: string[] },
  titleOf: (id: string) => string | undefined = () => undefined,
): Promise<'next' | 'replay' | 'menu'> {
  return new Promise((resolve) => {
    sound.chime()
    const done = (v: 'next' | 'replay' | 'menu') => {
      modal.close()
      resolve(v)
    }
    const card = h(
      'div',
      { class: 'card' },
      h('div', { class: 'eyebrow' }, 'Chapter complete'),
      h('h2', null, opts.title),
      h('div', { html: stars(opts.stars) }),
      h('p', null, `Checkpoint: ${opts.correct} of ${opts.total} correct on the first try.`),
      opts.summary.length
        ? h(
            'div',
            null,
            h('p', { style: { color: 'var(--fg)', margin: '0 0 6px', fontWeight: '700' } }, 'What you learned'),
            h('ul', { style: { margin: '0', paddingLeft: '20px', color: 'var(--fg-dim)', display: 'grid', gap: '4px' } }, ...opts.summary.map((s) => h('li', { html: fmt(s, titleOf).replace(/^<p>|<\/p>$/g, '') }))),
          )
        : null,
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'btn ghost', onclick: () => done('menu') }, 'Chapters'),
        h('button', { class: 'btn', onclick: () => done('replay') }, 'Replay'),
        opts.hasNext ? h('button', { class: 'btn primary', onclick: () => done('next') }, 'Next chapter') : null,
      ),
    )
    modal.open(card, { dismissable: false })
  })
}

// ----------------------------------------------------------------- codex

export function openCodex(modal: Modal, progress: Progress, focusId = '') {
  const unlocked = (id: string) => progress.hasCodex(id)
  let current = focusId && CODEX_BY_ID.has(focusId) ? focusId : (CODEX.find((e) => unlocked(e.id))?.id ?? CODEX[0].id)
  const list = h('nav', { class: 'codex-list', 'aria-label': 'Codex entries' })
  const body = h('article', { class: 'codex-body' })
  const titleOf = (id: string) => CODEX_BY_ID.get(id)?.title

  const render = () => {
    list.replaceChildren()
    for (const g of CODEX_GROUPS) {
      list.append(h('div', { class: 'group' }, g))
      for (const e of CODEX.filter((x) => x.group === g)) {
        const open = unlocked(e.id) || e.id === focusId
        list.append(
          h(
            'button',
            {
              class: `${e.id === current ? 'active' : ''} ${open ? '' : 'locked'}`,
              onclick: () => {
                current = e.id
                render()
              },
            },
            open ? e.title : '· · ·',
          ),
        )
      }
    }
    const e = CODEX_BY_ID.get(current)!
    if (unlocked(e.id) || e.id === focusId) {
      body.replaceChildren(h('h3', null, e.title), h('div', { class: 'short' }, e.short), h('div', { html: fmt(e.body, titleOf) }))
    } else {
      body.replaceChildren(
        h('h3', null, 'Not discovered yet'),
        h('p', { style: { color: 'var(--fg-dim)' } }, `This entry is in the "${esc(e.group)}" section. Keep playing to unlock it.`),
        h('button', { class: 'btn ghost', onclick: () => { focusId = e.id; render() } }, 'Peek anyway'),
      )
    }
  }
  body.addEventListener('click', (ev) => {
    const t = (ev.target as HTMLElement).closest('[data-codex]') as HTMLElement | null
    if (t) {
      current = t.dataset.codex!
      focusId = current
      render()
    }
  })
  render()
  const count = CODEX.filter((e) => unlocked(e.id)).length
  const card = h(
    'div',
    { class: 'card codex-card' },
    h(
      'header',
      null,
      h('div', null, h('div', { class: 'eyebrow' }, `${count} of ${CODEX.length} discovered`), h('h2', null, 'Codex')),
      h('button', { class: 'close-btn', 'aria-label': 'Close codex', onclick: () => modal.close() }, '×'),
    ),
    list,
    body,
  )
  modal.open(card)
}
