type Child = Node | string | number | null | undefined | false
type Attrs = Record<string, unknown>

/** Minimal hyperscript helper. `on*` attributes become listeners; `html` sets innerHTML. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue
      if (k === 'class') el.className = String(v)
      else if (k === 'html') el.innerHTML = String(v)
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener)
      else if (v === true) el.setAttribute(k, '')
      else el.setAttribute(k, String(v))
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue
    el.append(c instanceof Node ? c : String(c))
  }
  return el
}

export function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/**
 * Light markup for narration: **bold**, `code`, [[codex-id]] or
 * [[codex-id|label]] links, and blank-line paragraphs.
 */
export function fmt(s: string, titleOf: (id: string) => string | undefined = () => undefined) {
  return esc(s)
    .split(/\n{2,}/)
    .map((para) => {
      const html = para
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
        .replace(/\[\[([a-z0-9-]+)(?:\|([^\]]+))?\]\]/g, (_m, id: string, label?: string) => {
          const text = label ?? titleOf(id) ?? id
          return `<button type="button" class="term-link" data-codex="${id}">${text}</button>`
        })
        .replace(/\n/g, '<br>')
      return `<p>${html}</p>`
    })
    .join('')
}

export const ICON = {
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5V5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M8 7h7M8 11h5"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  term: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17l6-5-6-5M12 19h8"/></svg>',
  replay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  star: (on: boolean) =>
    `<svg viewBox="0 0 24 24"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z" fill="${on ? '#ffb21e' : 'none'}" stroke="${on ? '#ffb21e' : '#34497a'}" stroke-width="1.6" stroke-linejoin="round"/></svg>`,
}

/** Ditto, the guide: a little robot named after ZFS's ditto blocks (so there are two of it). */
export const DITTO_SVG = `<svg class="avatar" viewBox="0 0 48 48" aria-hidden="true">
  <rect x="9" y="12" width="34" height="30" rx="13" fill="none" stroke="#34497a" stroke-dasharray="2 3"/>
  <line x1="24" y1="10" x2="24" y2="4.5" stroke="#93a3c4" stroke-width="2"/>
  <circle cx="24" cy="4" r="2.6" fill="#ffb21e"/>
  <rect x="5" y="9" width="34" height="30" rx="13" fill="#1b2846" stroke="#4a64a0"/>
  <rect x="10" y="16" width="24" height="13" rx="6.5" fill="#070c18"/>
  <g class="eyes"><circle cx="17.5" cy="22.5" r="2.8" fill="#3ee0a1"/><circle cx="26.5" cy="22.5" r="2.8" fill="#3ee0a1"/></g>
  <path d="M18 33.5q4 2.6 8 0" stroke="#93a3c4" stroke-width="2" fill="none" stroke-linecap="round"/>
</svg>`

export function stars(n: number, max = 3, small = false) {
  return `<div class="stars${small ? ' small' : ''}" aria-label="${n} of ${max} stars">${Array.from({ length: max }, (_, i) => ICON.star(i < n)).join('')}</div>`
}
