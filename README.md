# ZFS, the Game

An interactive 3D game that teaches how ZFS works on the inside. Build pools, follow checksums through the block tree, pull the plug in the middle of a transaction group, fight bit rot, rebuild RAIDZ parity by hand, roll back ransomware, and type real `zpool` and `zfs` commands while you watch the blocks move.

It runs entirely in the browser (Three.js + TypeScript, no backend).

## Chapters

| # | Chapter | What you learn |
|---|---------|----------------|
| 1 | **Pool Architect** | Pools, vdevs, mirrors and RAIDZ; capacity vs. fault tolerance vs. IOPS; why losing one vdev loses the pool. |
| 2 | **The Block Tree** | The uberblock, MOS, object sets, dnodes, indirect and data blocks; block pointers, DVAs, compression; the Merkle tree of checksums and why it catches misdirected writes. |
| 3 | **Copy-on-Write** | How one change ripples up to the uberblock, batching in transaction groups, the uberblock ring, power loss mid-sync, torn uberblocks, and why ZFS has no fsck. |
| 4 | **Self-Healing** | Checksum verification on every read, automatic repair from a mirror, hardware RAID's blind spot, scrubs, and a cosmic-ray storm mini-game. |
| 5 | **RAIDZ** | Variable-width stripes, parity and padding sectors, rebuilding lost sectors by hand with XOR, resilvering only live data, the RAID-5 write hole, and RAIDZ2's Reed–Solomon parity. |
| 6 | **Snapshots** | Instant snapshots, the birth-txg rule (free now vs. deadlist), ransomware recovery with rollback, clones, and incremental `zfs send`. |
| 7 | **The Intent Log** | Sync vs. async writes, the ZIL, adding a SLOG (and why it isn't a write cache), crash replay, and what `sync=disabled` really costs. |
| 8 | **The ARC** | MRU and MFU lists, ghost lists and the adaptive target, scan resistance against a backup job (compared live with plain LRU), and the L2ARC. |
| 9 | **Pool Doctor** | Final exam: diagnose and fix five on-call incidents with real commands (`zpool replace`, `scrub` and `clear`, `zfs rollback`, freeing space, adding a SLOG). |

Each chapter ends with a short checkpoint quiz worth up to three stars. The **Codex** collects 45 glossary entries as you discover them.

## Playing

- Drag to orbit, scroll or pinch to zoom, right-drag (or two-finger drag) to pan.
- Click blocks and drives to inspect them; the inspector shows zdb-style block pointers.
- The buttons under the dialog run the same commands shown beneath them. You can also type them in the terminal (`help` lists what each chapter supports).
- Settings let you lower graphics quality, speed up animations and mute sound. Progress is saved in your browser.

## Development

```sh
npm install
npm run dev          # local dev server
npm test             # unit tests for the ZFS models
npm run build        # static site in dist/
npm run build:single # one self-contained HTML file in dist-single/
```

The GitHub Actions workflow runs the tests and builds on every push and pull request, and deploys `main` to GitHub Pages. To turn deployment on, set **Settings → Pages → Source** to **GitHub Actions**.

### Layout

```
src/
  zfs/        Pure models with unit tests: pool math, fletcher4, a copy-on-write
              block tree with txgs and snapshots, RAIDZ geometry and parity
              (incl. GF(2^8) P+Q reconstruction), the ARC algorithm, zpool status.
  engine/     Three.js stage (camera, picking, labels, bloom), tweens and
              cancellable scopes, shared meshes (blocks, drives, platters).
  scenes/     Reusable visualisations: the block tree view and block inspector.
  ui/         HUD, dialog, terminal, quiz, codex, settings, sound.
  chapters/   One file per chapter: an async script that drives the scene.
  content/    Codex entries and the sample files (cat.png is real pixel art).
```

## How accurate is it?

The mechanics follow OpenZFS: real fletcher4 checksums chained through block pointers, copy-on-write up to an uberblock ring, the birth-txg free/deadlist rule, RAIDZ column layout and skip sectors as in `vdev_raidz_map_alloc()`, P/Q parity over GF(2⁸) with the 0x11d polynomial, the Megiddo–Modha ARC, and status messages modelled on `zpool status`.

To keep things watchable, it simplifies:

- Every block occupies one slot, regardless of size, and pools have a single top-level vdev in the block-tree chapters.
- The uberblock ring has 8 slots; real vdev labels hold 32 at ashift=12 (128 at ashift=9).
- The MOS points straight at each dataset's object set, skipping the DSL directory and dataset objects in between.
- Data blocks hold 64 representative bytes rather than 128 KiB.
- Timings (disk latency, txg intervals, resilver speed) are illustrative.
- The ARC has eight equal-sized blocks; the real one handles variable sizes, memory pressure, prefetch and compressed buffers.

This is an unofficial fan project and is not affiliated with the OpenZFS project.

## License

[Apache License 2.0](LICENSE)
