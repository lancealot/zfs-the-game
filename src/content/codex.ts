/**
 * The Codex: a glossary of ZFS internals. Entries unlock as chapters
 * introduce them. Bodies use the same light markup as narration.
 */
export interface CodexEntry {
  id: string
  title: string
  group: string
  short: string
  body: string
}

export const CODEX_GROUPS = [
  'Pool layout',
  'On-disk format',
  'Transactions',
  'Integrity',
  'Snapshots',
  'Caching and logging',
  'Operations',
] as const

const E = (id: string, group: (typeof CODEX_GROUPS)[number], title: string, short: string, body: string): CodexEntry => ({
  id,
  group,
  title,
  short,
  body,
})

export const CODEX: CodexEntry[] = [
  // ------------------------------------------------------------ Pool layout
  E(
    'pool',
    'Pool layout',
    'Pool (zpool)',
    'All the storage ZFS manages as one unit.',
    `A pool is built from one or more top-level [[vdev|vdevs]], and every dataset in the pool shares all of its free space. There is no partitioning step and no fixed-size volume.

ZFS spreads new writes across all top-level vdevs ([[striping|dynamic striping]]). That is why the pool itself has no redundancy: if any top-level vdev fails completely, the whole pool is lost. Redundancy lives inside each vdev.

Created with \`zpool create tank mirror sda sdb\`; grown later with \`zpool add\`.`,
  ),
  E(
    'vdev',
    'Pool layout',
    'Vdev',
    'Virtual device: a building block of a pool.',
    `A vdev is a single disk, a [[mirror]], a [[raidz|RAIDZ]] group, or a dRAID group. Vdevs that hold pool data are called top-level vdevs.

Support vdevs have special jobs: \`log\` holds the [[zil|ZIL]] (a [[slog|SLOG]]), \`cache\` holds the [[l2arc|L2ARC]], \`special\` stores metadata and optionally small blocks on fast media, \`dedup\` stores the dedup table, and \`spare\` disks wait to replace failed ones.`,
  ),
  E(
    'mirror',
    'Pool layout',
    'Mirror',
    'Every block written in full to each disk.',
    `An n-way mirror keeps n identical copies and survives n−1 failed disks. Reads can be served by any side, so mirrors read fast. Usable space equals the smallest member disk.

A pool of several 2-way mirrors (sometimes called "striped mirrors", like RAID-10) gives the best random I/O and the fastest [[resilver|resilvers]], at 50% space efficiency.`,
  ),
  E(
    'raidz',
    'Pool layout',
    'RAIDZ',
    'ZFS parity groups: single, double or triple parity.',
    `RAIDZ1, RAIDZ2 and RAIDZ3 store 1, 2 or 3 [[parity]] sectors per row and survive that many failed disks per vdev. Usable space is roughly (disks − parity) × smallest disk, less some padding.

Every RAIDZ write is a full, variable-width stripe written to fresh space. There is no read-modify-write and no [[write-hole|write hole]]. The trade-off: one RAIDZ vdev delivers roughly the random IOPS of a single disk, however wide it is.

Since OpenZFS 2.3, \`zpool attach\` can widen an existing RAIDZ vdev one disk at a time.`,
  ),
  E(
    'striping',
    'Pool layout',
    'Dynamic striping',
    'Writes are spread across every top-level vdev.',
    `ZFS has no fixed stripe across vdevs. Each new block is allocated on whichever top-level vdev the allocator picks, weighted toward vdevs with more free space. Adding a vdev immediately adds its capacity and performance to the pool.

Existing data is not rebalanced when you add a vdev; it spreads out naturally as data is rewritten.`,
  ),
  E(
    'ashift',
    'Pool layout',
    'ashift',
    'The sector size of a vdev, as a power of two.',
    `\`ashift=12\` means 4 KiB sectors (2¹²). It is fixed when the vdev is created and is the smallest unit ZFS will allocate on it.

Set it to at least the disk's physical sector size. Too small, and a "512e" drive has to do slow read-modify-write internally for every sector ZFS writes.`,
  ),

  // --------------------------------------------------------- On-disk format
  E(
    'uberblock',
    'On-disk format',
    'Uberblock',
    'The root of the whole pool. Magic number 0x00bab10c.',
    `The uberblock records the [[txg]] it was written in and holds a [[blkptr|block pointer]] to the [[mos|MOS]]. Everything in the pool is reachable from it. Its magic number, 0x00bab10c, reads as "oo-ba-bloc".

Each disk keeps a ring of uberblock slots in its [[vdev-label|labels]]. Every txg writes a new uberblock into the next slot. On import, ZFS picks the uberblock with the highest txg whose own checksum is valid.

Writing the uberblock is the commit point: until it lands, the previous tree is still the official one. \`zpool import -F\` can rewind to an older uberblock if the newest txgs are damaged.`,
  ),
  E(
    'vdev-label',
    'On-disk format',
    'Vdev label',
    'Four copies of identity and uberblocks on every disk.',
    `Each disk carries four 256 KiB labels: two at the front and two at the end. Losing one end of the disk to a stray write doesn't make the disk unidentifiable.

A label holds the pool configuration as an nvlist (pool name, GUIDs, vdev tree) and the ring of [[uberblock|uberblocks]].`,
  ),
  E(
    'mos',
    'On-disk format',
    'MOS (Meta Object Set)',
    'The pool-wide object set the uberblock points to.',
    `The MOS holds the pool's own bookkeeping: the directory of datasets and [[snapshot|snapshots]], space maps that track free space, the dedup table, pool properties and more. Every dataset's [[objset|object set]] is reached through the MOS.

ZFS stores three copies of MOS blocks by default ([[ditto]]), because losing it would lose everything.`,
  ),
  E(
    'objset',
    'On-disk format',
    'Object set',
    'A dataset, volume or snapshot as a collection of objects.',
    `An object set's root block holds the "meta-dnode", whose block pointers lead to blocks full of [[dnode|dnodes]]: one per object. A filesystem's files and directories, a volume's data, and a snapshot's frozen view are all object sets.`,
  ),
  E(
    'dnode',
    'On-disk format',
    'Dnode',
    'The descriptor of one object, such as a file.',
    `A dnode is 512 bytes or more. It records the object's type, block size and number of [[indirect|indirect levels]], and holds one to three [[blkptr|block pointers]]. Regular files usually have one, because file attributes fill the dnode's "bonus" area.

So a file that fits in one block points straight at its data. Anything bigger goes through indirect blocks. Many dnodes are packed into each 16 KiB dnode block.`,
  ),
  E(
    'blkptr',
    'On-disk format',
    'Block pointer (blkptr)',
    'The 128-byte record a parent uses to point at a child.',
    `A block pointer holds up to three [[dva|DVAs]] (addresses), the logical and physical size, the compression and checksum algorithms, the block type and level, the block's [[birth|birth txg]], and the 256-bit [[checksum]] of the child.

The checksum field is what makes the tree self-validating: a parent vouches for each of its children.

\`zdb\` prints one like:
\`DVA[0]=<0:4a2000:8000> [L0 ZFS plain file] fletcher4 lz4 unencrypted LE contiguous unique single size=20000L/8000P birth=1042L/1042P fill=1 cksum=…\``,
  ),
  E(
    'dva',
    'On-disk format',
    'DVA',
    'Data Virtual Address: which vdev, which offset.',
    `A DVA names a top-level vdev, an offset within it and the allocated size. \`zdb\` prints it as \`<vdev:offset:asize>\` in hex, for example \`<0:4a2000:20000>\`.

A block pointer has room for three DVAs. Extra copies are [[ditto]] blocks.`,
  ),
  E(
    'indirect',
    'On-disk format',
    'Indirect block',
    'A block full of block pointers.',
    `A 128 KiB indirect block holds 1,024 block pointers. Data blocks are level 0 (L0); the indirect blocks above them are L1, L2 and so on. A two-level tree addresses 1,024 data blocks, and each extra level multiplies that by 1,024.`,
  ),
  E(
    'recordsize',
    'On-disk format',
    'recordsize',
    'The largest block a file in a dataset can use.',
    `128 KiB by default. Large sequential files (video, backups) do well with 1 MiB records. Databases that do small random I/O prefer a recordsize matching their page size (8–16 KiB). Volumes use the similar \`volblocksize\`.

A file smaller than the recordsize is stored in a single block of just the size it needs (rounded up to a multiple of 512 bytes); its allocation on disk rounds up to the vdev's sector size.`,
  ),
  E(
    'compression',
    'On-disk format',
    'Compression',
    'Each block is compressed on its own before it is written.',
    `\`lsize\` is a block's logical size and \`psize\` its physical size after compression. \`compression=on\` (the default since OpenZFS 2.2) means LZ4, fast enough to be nearly free, and it often speeds things up by writing less. zstd trades CPU for better ratios.

A block that doesn't shrink by at least 12.5% is stored uncompressed, so incompressible data wastes little effort.`,
  ),
  E(
    'embedded',
    'On-disk format',
    'Embedded block',
    'Tiny data stored inside the block pointer itself.',
    `When a block compresses to 112 bytes or less, ZFS can put the data straight into the 128-byte block pointer instead of allocating a block. A tiny file then costs no data block at all.`,
  ),
  E(
    'ditto',
    'On-disk format',
    'Ditto blocks',
    'Extra copies of important blocks.',
    `A block pointer can carry up to three DVAs, each a full copy of the block, placed on different vdevs when possible or far apart on a single disk. By default ZFS keeps two copies of dataset metadata and three of pool-wide metadata, even on a single-disk pool.

The \`copies\` property extends this to user data. Ditto blocks guard against bad sectors. They are no substitute for a second disk.`,
  ),
  E(
    'merkle',
    'On-disk format',
    'Merkle tree',
    'Every parent stores a checksum of each child.',
    `In ZFS, every block pointer holds the checksum of the block it points to, all the way up to the [[uberblock]]. Verifying from the root down proves that each block is exactly what was written.

Keeping the checksum in the parent catches failures that a checksum stored next to the data would miss. A misdirected write puts a valid-looking block in the wrong place. A phantom write silently never happens, leaving stale data behind. Either way the data matches its own checksum, but not the one its parent expects.`,
  ),

  // ----------------------------------------------------------- Transactions
  E(
    'cow',
    'Transactions',
    'Copy-on-write',
    'Live data is never overwritten in place.',
    `A changed block is written to free space. Its address and checksum change, so its parent must be rewritten to point at it, and so on up to the [[uberblock]].

Until the new uberblock lands, the old tree is entirely intact. The pool on disk is therefore always consistent: no fsck, no journal replay for metadata, and a crash can never leave a half-updated structure. The same mechanism makes [[snapshot|snapshots]] nearly free and removes the RAID [[write-hole|write hole]].`,
  ),
  E(
    'txg',
    'Transactions',
    'Transaction group (txg)',
    'Changes are batched and committed together.',
    `At any moment one txg is open and accepting changes, one may be quiescing (waiting for in-flight operations to finish), and one may be syncing (being written to disk). Txg numbers only ever increase.

A txg is synced at least every \`zfs_txg_timeout\` seconds (5 by default), or sooner when enough dirty data piles up. Batching many changes into one sync means shared parent blocks are rewritten once, not once per change.`,
  ),

  // -------------------------------------------------------------- Integrity
  E(
    'checksum',
    'Integrity',
    'Checksum',
    'Every block is verified on every read.',
    `The default algorithm is fletcher4: fast and good at catching corruption, though not cryptographic. sha256, sha512, skein, edonr and blake3 are also available. Dedup needs a cryptographic checksum, and one also enables "nopwrite", which skips rewriting identical data.

The checksum is stored in the parent's [[blkptr|block pointer]], never beside the data it protects. That is the [[merkle|Merkle tree]].`,
  ),
  E(
    'bitrot',
    'Integrity',
    'Silent data corruption',
    'Wrong data returned without any I/O error.',
    `Bit rot, firmware bugs, misdirected writes, phantom writes and flaky cables can all hand back the wrong bytes while reporting success. A plain RAID-1 controller that sees two different copies can't tell which is right.

ZFS can, because each read is checked against the checksum held in the parent block pointer.`,
  ),
  E(
    'selfheal',
    'Integrity',
    'Self-healing',
    'Bad copies are detected and rewritten automatically.',
    `When a read fails its checksum and the vdev has redundancy, ZFS tries the other copies, or reconstructs the block from [[parity]]. It returns the good data to the application and rewrites the bad copy in place.

Each checksum failure is counted in that device's CKSUM column of \`zpool status\`. Without redundancy ZFS can still detect the error and report the damaged file, but it can't fix it.`,
  ),
  E(
    'scrub',
    'Integrity',
    'Scrub',
    'Read and verify every allocated block in the pool.',
    `\`zpool scrub tank\` walks every block, verifies its checksum and repairs what it can. Scrubs find latent errors while the redundancy to fix them still exists, before a disk failure turns a bad sector into lost data.

Many admins scrub monthly; weekly is common for consumer-grade disks. Scrubs run at low priority alongside normal I/O.`,
  ),
  E(
    'resilver',
    'Integrity',
    'Resilver',
    'Rebuilding redundancy onto a replaced or returning disk.',
    `ZFS walks the block tree and copies only allocated blocks. A mostly empty disk resilvers in minutes, unlike a hardware RAID rebuild, which copies every sector whether it holds data or not.

If a disk was only briefly offline, ZFS resilvers just the txgs it missed. Mirrors can also use a faster sequential resilver (\`zpool replace -s\`).`,
  ),
  E(
    'parity',
    'Integrity',
    'Parity',
    'Extra sectors that let missing data be recomputed.',
    `RAIDZ1's parity sector P is the XOR of the data sectors in its row. Lose any one sector and XOR the survivors to get it back.

RAIDZ2 adds Q and RAIDZ3 adds R, computed with Reed–Solomon arithmetic in the finite field GF(2⁸). With P and Q, any two missing sectors in a row become two equations in two unknowns.`,
  ),
  E(
    'write-hole',
    'Integrity',
    'RAID write hole',
    'Parity that silently disagrees with its data after a crash.',
    `RAID-5 and RAID-6 update part of a stripe by rewriting data and parity in place, which takes more than one write. Power loss between them leaves parity that no longer matches. Nobody notices until a disk fails and the bad parity rebuilds garbage.

RAIDZ never updates a stripe in place. Each block is a full stripe written to new space, and it only becomes live when the uberblock commits.`,
  ),

  // -------------------------------------------------------------- Snapshots
  E(
    'snapshot',
    'Snapshots',
    'Snapshot',
    'An instant, read-only, point-in-time copy of a dataset.',
    `A snapshot keeps the old root of the dataset's block tree. Creating one takes the same time for 1 KB or 100 TB, and it costs no space at first.

Space grows only as the live dataset diverges: blocks the live data stops using are kept for the snapshot. \`USED\` on a snapshot is the space its unique blocks hold, and \`REFER\` is everything it can see.`,
  ),
  E(
    'birth',
    'Snapshots',
    'Birth txg',
    'The txg in which a block was written.',
    `Every block pointer records its block's birth txg. When the live dataset frees a block, ZFS compares that birth txg with the txg of the most recent snapshot:

**Born after the snapshot**: no snapshot can reference it, so free it immediately.
**Born at or before the snapshot**: a snapshot still needs it, so put it on the [[deadlist]].

One integer comparison replaces any need for reference counting.`,
  ),
  E(
    'deadlist',
    'Snapshots',
    'Deadlist',
    'Blocks the live data dropped but a snapshot still holds.',
    `Each dataset and snapshot keeps a deadlist. When a snapshot is destroyed, ZFS combines its deadlist with the next snapshot's, and uses birth txgs to work out exactly which blocks just became unreferenced. No scan of the whole tree is needed.`,
  ),
  E(
    'clone',
    'Snapshots',
    'Clone',
    'A writable dataset made from a snapshot.',
    `A clone starts out sharing every block with its origin snapshot and consumes space only as it diverges. It is great for test copies of databases or VM templates.

The origin snapshot can't be destroyed while the clone exists, unless you \`zfs promote\` the clone, which swaps the parent-child relationship.`,
  ),
  E(
    'rollback',
    'Snapshots',
    'Rollback',
    'Return a dataset to a snapshot, discarding later changes.',
    `\`zfs rollback tank/home@monday\` throws away every change made after the snapshot. Blocks born after it are simply freed, so a rollback takes seconds. If newer snapshots exist you must add \`-r\`, which destroys them.

Snapshots are read-only, so ransomware running as an ordinary user can't encrypt them.`,
  ),
  E(
    'send',
    'Snapshots',
    'Send and receive',
    'Replicate snapshots as a stream.',
    `\`zfs send tank/home@b | ssh backup zfs receive pool/home\` copies a snapshot to another pool.

An incremental send (\`zfs send -i @a tank/home@b\`) only needs blocks born after @a. ZFS finds them by skipping every subtree whose block pointer has an older birth txg, without comparing any file contents.`,
  ),

  // ---------------------------------------------------- Caching and logging
  E(
    'zil',
    'Caching and logging',
    'ZIL (ZFS Intent Log)',
    'Makes synchronous writes durable before the txg commits.',
    `Applications that call fsync, open files with O_SYNC, or speak NFS and databases need a write to be on stable storage before the call returns. Waiting up to 5 seconds for the next [[txg]] would be far too slow.

So ZFS appends a log record to the ZIL immediately, acknowledges the write, and still writes the data normally with the next txg. Once that txg commits, the log records are discarded. The ZIL is only ever read after a crash, to replay writes that had been acknowledged.`,
  ),
  E(
    'slog',
    'Caching and logging',
    'SLOG (separate log device)',
    'A fast dedicated device for the ZIL.',
    `Added with \`zpool add tank log nvme0n1\`. It moves ZIL writes off the main pool disks onto low-latency, power-loss-protected storage, cutting sync-write latency.

A SLOG is **not** a write cache. Data still goes from RAM to the pool in the next txg; the SLOG is written constantly but read only during crash recovery. Mirror it to avoid losing a few seconds of acknowledged writes if it dies at the same moment as a crash.`,
  ),
  E(
    'sync',
    'Caching and logging',
    'sync property',
    'Controls how synchronous write requests are honored.',
    `\`sync=standard\` (the default) does what applications ask. \`sync=always\` treats every write as synchronous. \`sync=disabled\` acknowledges sync writes without logging them: fast, but a crash can lose writes that applications were told were safe.`,
  ),
  E(
    'arc',
    'Caching and logging',
    'ARC',
    'Adaptive Replacement Cache: ZFS\'s RAM cache.',
    `The ARC splits cached blocks between two lists. MRU holds blocks used once recently and MFU holds blocks used more than once. [[ghost|Ghost lists]] remember what was recently evicted from each, and the ARC continuously moves its target split between MRU and MFU based on ghost hits.

A one-time scan, like a backup, only churns MRU, so the frequently used working set in MFU survives. That is called scan resistance. The ARC also caches blocks compressed, fitting more in RAM. (A second access within about 62 ms doesn't count as a repeat, so a read plus its own prefetch won't promote a block to MFU.)`,
  ),
  E(
    'ghost',
    'Caching and logging',
    'Ghost lists',
    'Headers of recently evicted blocks, without their data.',
    `A hit on the MRU ghost list means "we evicted a recent block too soon", so the ARC grows MRU's target. A hit on the MFU ghost list grows MFU's share instead. Ghosts cost only a small header each, so the ARC learns from a history twice as long as what it actually caches.`,
  ),
  E(
    'l2arc',
    'Caching and logging',
    'L2ARC',
    'A second-level read cache on SSDs.',
    `Added with \`zpool add tank cache nvme1n1\`. Blocks near the eviction end of the ARC are copied to it, so they can still be read quickly after leaving RAM. Each cached block costs a small header in RAM. Since OpenZFS 2.0 the L2ARC survives reboots.`,
  ),

  // ------------------------------------------------------------- Operations
  E(
    'states',
    'Operations',
    'Device states',
    'ONLINE, DEGRADED, FAULTED, UNAVAIL, OFFLINE, REMOVED.',
    `**ONLINE**: working normally. **DEGRADED**: a vdev lost a member but still has enough replicas; a single disk can also be degraded after too many checksum errors. **FAULTED**: a device was taken out of service after too many errors. **UNAVAIL**: a device can't be opened. **OFFLINE**: taken offline by an admin. **REMOVED**: physically unplugged.

When a top-level vdev has insufficient replicas, the pool itself becomes UNAVAIL or SUSPENDED.`,
  ),
  E(
    'zpool-status',
    'Operations',
    'zpool status',
    'The first command to run when something seems wrong.',
    `Shows the pool's health, each device's state, its READ, WRITE and CKSUM error counters, scrub or resilver progress, a suggested \`action:\`, and with \`-v\` the files that have permanent errors.`,
  ),
  E(
    'zpool-replace',
    'Operations',
    'zpool replace',
    'Swap a failed disk for a new one.',
    `\`zpool replace tank sdb sdj\` attaches the new disk alongside the old one and starts a [[resilver]]. The old disk drops out once the resilver completes. If the new disk sits in the same slot under the same name, \`zpool replace tank sdb\` is enough.`,
  ),
  E(
    'zpool-clear',
    'Operations',
    'zpool clear',
    'Reset error counters after fixing the cause.',
    `Use \`zpool clear tank\` after you've fixed what caused the errors, such as a loose cable, and a [[scrub]] has confirmed the data is good.

Clearing doesn't repair any data. It resets the error counters, puts FAULTED or DEGRADED devices back into service, and resumes a pool that was suspended by I/O failures. Fix the cause first.`,
  ),
  E(
    'spare',
    'Operations',
    'Hot spare',
    'A standby disk that steps in when another fails.',
    `Added with \`zpool add tank spare sdk\`. When a disk faults, the ZFS event daemon (zed) can automatically start resilvering onto the spare. After you replace the failed disk, the spare returns to standby.`,
  ),
]

export const CODEX_BY_ID = new Map(CODEX.map((e) => [e.id, e]))
