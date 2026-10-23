import { h } from './dom'
import type { Sound } from './sound'

/** Return true if the command was handled. */
export type CommandHandler = (argv: string[], line: string) => boolean | void | Promise<boolean | void>

export function tokenize(line: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

/**
 * A pretend root shell. Chapters install a handler for the zpool/zfs
 * commands they support; buttons in the HUD echo their equivalent command
 * here so players see what they would type on a real system.
 */
export class Terminal {
  readonly el: HTMLElement
  private out: HTMLElement
  private input: HTMLInputElement
  private suggestEl: HTMLElement
  private history: string[] = []
  private hIndex = -1
  private handler: CommandHandler | null = null
  private helpText = ''
  private busy = false
  /** Notified after every command, typed or echoed. */
  onCommand: ((argv: string[]) => void) | null = null

  constructor(private sound: Sound) {
    this.out = h('div', { class: 'out', role: 'log', 'aria-label': 'Terminal output' })
    this.input = h('input', {
      id: 'term-input',
      type: 'text',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      'aria-label': 'Terminal command',
      placeholder: 'type a command, or "help"',
    }) as HTMLInputElement
    this.suggestEl = h('div', { class: 'suggest' })
    const bar = h(
      'div',
      { class: 'bar', role: 'button', tabindex: '0', 'aria-label': 'Toggle terminal' },
      h('span', { class: 'dot' }),
      'root@lab — zsh',
      h('span', { class: 'chev' }, '▾'),
    )
    bar.addEventListener('click', () => this.toggle())
    bar.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        this.toggle()
      }
    })
    this.el = h(
      'section',
      { class: 'terminal panel' },
      bar,
      this.out,
      h('form', { class: 'in', onsubmit: (e: Event) => this.submit(e) }, h('label', { for: 'term-input' }, '#'), this.input),
      this.suggestEl,
    )
    this.input.addEventListener('keydown', (e) => this.onKey(e))
    if (window.matchMedia('(max-width: 860px)').matches) this.el.classList.add('collapsed')
  }

  setHandler(fn: CommandHandler | null, help = '') {
    this.handler = fn
    this.helpText = help
  }

  setSuggestions(cmds: string[]) {
    this.suggestEl.replaceChildren(
      ...cmds.map((c) =>
        h(
          'button',
          {
            type: 'button',
            onclick: () => {
              this.sound.tick()
              void this.run(c)
            },
          },
          c,
        ),
      ),
    )
  }

  print(text: string, cls = '') {
    const line = h('div', { class: cls })
    line.textContent = text
    this.append(line)
  }

  /** Prints pre-built HTML. Callers must escape any untrusted text. */
  printHTML(html: string) {
    this.append(h('div', { html }))
  }

  echo(cmd: string) {
    const line = h('div', { class: 'cmd' })
    line.textContent = cmd
    this.append(line)
    this.onCommand?.(tokenize(cmd))
  }

  /** Runs a line as if typed. */
  async run(line: string) {
    if (this.busy) return
    const argv = tokenize(line)
    if (argv.length === 0) return
    this.history.push(line)
    this.hIndex = -1
    const echoLine = h('div', { class: 'cmd' })
    echoLine.textContent = line
    this.append(echoLine)
    this.busy = true
    try {
      let handled = false
      if (argv[0] === 'clear') {
        this.clear()
        handled = true
      } else if (this.handler) {
        handled = (await this.handler(argv, line)) === true
      }
      if (!handled) this.builtin(argv)
      this.onCommand?.(argv)
    } finally {
      this.busy = false
    }
  }

  private builtin(argv: string[]) {
    const [cmd, sub] = argv
    switch (cmd) {
      case 'help':
        this.print(this.helpText || 'Nothing to do here yet.', '')
        this.print("Tip: the buttons under the dialog run these same commands. 'clear' wipes the screen.", 'dim')
        return
      case 'sudo':
        this.print("You're already root. With great power comes great zpool destroy.", 'dim')
        return
      case 'whoami':
        this.print('root')
        return
      case 'fsck':
      case 'fsck.zfs':
        this.print('fsck.zfs: ZFS has no fsck. Copy-on-write keeps the pool consistent; use `zpool scrub` to verify data.', 'warn')
        return
      case 'zpool':
      case 'zfs':
        if (!sub) {
          this.print(`usage: ${cmd} <command> [args]... (type 'help' to see what works here)`, 'err')
        } else {
          this.print(`${cmd} ${sub}: not available in this chapter. Type 'help' to see what is.`, 'err')
        }
        return
      default:
        this.print(`zsh: command not found: ${cmd}`, 'err')
    }
  }

  clear() {
    this.out.replaceChildren()
  }

  toggle(force?: boolean) {
    const collapsed = force === undefined ? !this.el.classList.contains('collapsed') : !force
    this.el.classList.toggle('collapsed', collapsed)
    if (!collapsed) {
      this.out.scrollTop = this.out.scrollHeight
      if (!window.matchMedia('(pointer: coarse)').matches) this.input.focus()
    }
  }

  reset() {
    this.clear()
    this.handler = null
    this.helpText = ''
    this.setSuggestions([])
    this.onCommand = null
    this.busy = false
  }

  private append(node: HTMLElement) {
    this.out.append(node)
    while (this.out.childElementCount > 400) this.out.firstElementChild?.remove()
    this.out.scrollTop = this.out.scrollHeight
  }

  private submit(e: Event) {
    e.preventDefault()
    const line = this.input.value.trim()
    this.input.value = ''
    if (line) {
      this.sound.tick()
      void this.run(line)
    }
  }

  private onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowUp') {
      if (this.history.length === 0) return
      e.preventDefault()
      this.hIndex = this.hIndex < 0 ? this.history.length - 1 : Math.max(0, this.hIndex - 1)
      this.input.value = this.history[this.hIndex]
    } else if (e.key === 'ArrowDown') {
      if (this.hIndex < 0) return
      e.preventDefault()
      this.hIndex++
      if (this.hIndex >= this.history.length) {
        this.hIndex = -1
        this.input.value = ''
      } else this.input.value = this.history[this.hIndex]
    } else if (e.key === 'Tab') {
      const buttons = [...this.suggestEl.querySelectorAll('button')].map((b) => b.textContent ?? '')
      const v = this.input.value
      const match = buttons.find((b) => b.startsWith(v) && b !== v)
      if (match) {
        e.preventDefault()
        this.input.value = match
      }
    } else if (e.key === 'Escape') {
      this.input.blur()
    }
  }
}

