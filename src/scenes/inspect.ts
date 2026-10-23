import { h } from '../ui/dom'
import { type Blk, type CowPool, type Uber, zdbLine, dvaText, copiesOf, RING } from '../zfs/blocktree'
import { cksumHex, cksumShort, fletcher4, cksumEqual } from '../zfs/checksum'
import { ctime } from '../zfs/units'

const KIND_TEXT: Record<Blk['kind'], { title: string; codex: string; blurb: string }> = {
  mos: {
    title: 'MOS (meta object set)',
    codex: 'mos',
    blurb: 'Pool-wide bookkeeping: the directory of datasets and snapshots, space maps and properties. The uberblock points here.',
  },
  objset: {
    title: 'Object set',
    codex: 'objset',
    blurb: 'The root of one dataset. It points at the blocks that hold every dnode in the dataset.',
  },
  dnode: {
    title: 'Dnode block',
    codex: 'dnode',
    blurb: 'Holds the dnodes (one per file) of this dataset. Each dnode has a block pointer to the file\'s data, or to an indirect block for bigger files.',
  },
  indirect: {
    title: 'Indirect block (L1)',
    codex: 'indirect',
    blurb: 'A block full of block pointers, one per data block of the file. Up to 1,024 of them in a 128 KiB indirect block.',
  },
  data: {
    title: 'Data block (L0)',
    codex: 'recordsize',
    blurb: 'Your actual file contents, up to recordsize (128 KiB by default) per block.',
  },
}

const hexSize = (n: number) => `0x${n.toString(16)} (${n >= 1024 ? `${n / 1024} KiB` : `${n} B`})`

/** Inspector body for a block, framed as the block pointer its parent holds. */
export function describeBlock(pool: CowPool, b: Blk, extra?: HTMLElement | null): HTMLElement {
  const parent = pool.parentOf(b) ?? findParentAnywhere(pool, b)
  const k = KIND_TEXT[b.kind]
  const onDisk = pool.media[b.slot]
  const ok = !!onDisk && cksumEqual(fletcher4(onDisk), b.cksum)
  const rows: Array<[string, string]> = [
    ['held by', parent ? parentName(parent) : b === pool.uber.root ? 'the uberblock' : '(nothing: about to be freed)'],
    ...Array.from({ length: copiesOf(b) }, (_, i) => [`DVA[${i}]`, dvaText(b, i)] as [string, string]),
    ['lsize', hexSize(b.lsize)],
    ['psize', `${hexSize(b.psize)}${b.comp === 'lz4' ? ' · lz4' : ' · uncompressed'}`],
    ['birth txg', String(b.birth)],
    ['checksum', `fletcher4 ${cksumShort(b.cksum)}…`],
    ['on disk', ok ? 'matches ✓' : 'MISMATCH ✗'],
  ]
  return h(
    'div',
    null,
    h('p', { class: 'note', style: { marginTop: '0' } }, k.blurb, ' ', h('button', { class: 'term-link', 'data-codex': k.codex }, 'More')),
    h('dl', { class: 'kv' }, ...rows.flatMap(([a, v]) => [h('dt', null, a), h('dd', { style: v.includes('✗') ? { color: 'var(--red)' } : {} }, v)])),
    extra ?? null,
    h('div', { class: 'zdb', title: 'How zdb would print this block pointer' }, `# zdb -ddddd\n${zdbLine(b, cksumHex(b.cksum))}`),
  )
}

function findParentAnywhere(pool: CowPool, b: Blk) {
  for (const s of pool.snapshots) {
    const p = pool.parentOf(b, s.root)
    if (p) return p
  }
  return null
}

function parentName(p: Blk) {
  switch (p.kind) {
    case 'mos':
      return 'MOS'
    case 'objset':
      return `objset ${p.meta.dataset}`
    case 'dnode':
      return 'dnode block'
    case 'indirect':
      return `L1 of ${p.meta.file}`
    default:
      return p.kind
  }
}

export function describeUber(pool: CowPool, u: Uber = pool.uber): HTMLElement {
  const date = ctime(new Date(u.timestamp * 1000))
  const rows: Array<[string, string]> = [
    ['ub_magic', '0x00bab10c'],
    ['ub_version', '5000'],
    ['ub_txg', String(u.txg)],
    ['ub_guid_sum', '0x6c4f1b9d02e8a7f3'],
    ['ub_timestamp', `${u.timestamp} (${date})`],
    ['ub_rootbp', `${dvaText(u.root)} → MOS`],
    ['rootbp cksum', cksumShort(u.root.cksum) + '…'],
    ['ring slot', `${u.txg % RING} of ${RING} here (slot = txg mod ${RING}; real labels hold 32 at ashift=12)`],
  ]
  return h(
    'div',
    null,
    h(
      'p',
      { class: 'note', style: { marginTop: '0' } },
      'The root of everything, kept in a ring of slots in each disk\'s labels. On import ZFS picks the valid uberblock with the highest txg. ',
      h('button', { class: 'term-link', 'data-codex': 'uberblock' }, 'More'),
    ),
    h('dl', { class: 'kv' }, ...rows.flatMap(([a, v]) => [h('dt', null, a), h('dd', null, v)])),
  )
}

/** What `zdb -u tank` prints for the active uberblock. */
export function zdbUberText(pool: CowPool): string {
  const u = pool.uber
  return [
    'Uberblock:',
    '        magic = 0000000000bab10c',
    '        version = 5000',
    `        txg = ${u.txg}`,
    '        guid_sum = 7804356107563362291',
    `        timestamp = ${u.timestamp} UTC = ${ctime(new Date(u.timestamp * 1000))}`,
    `        bp = ${zdbLine(u.root, cksumHex(u.root.cksum))}`,
    '        mmp_magic = 00000000a11cea11',
    '        mmp_delay = 0',
    '        mmp_valid = 0',
    '        checkpoint_txg = 0',
    '        raidz_reflow state=0 off=0',
  ].join('\n')
}
